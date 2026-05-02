import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import gsap from 'gsap';


// --- Constants ---
const BOOTH_WIDTH = 11.8;
const BOOTH_DEPTH = 12;
const WALL_HEIGHT = 12;
const TABLET_TABLE_HEIGHT = 3.8; 
const COLLAB_TABLE_HEIGHT = 2.8;
const TABLE_SIZE = { w: 6.5, d: 3.0 };
/** Solid cloth block: floor (y=0) to former tabletop top (was legs + thin slab). */
const COLLAB_TABLE_CLOTH_H = COLLAB_TABLE_HEIGHT + 0.1;
/** Table spot pair offset on X — decorative track tubes use the same spacing as the real spots. */
const TABLE_SPOT_PAIR_OFFSET_X = 2.12;

const TABLET_A_POS = new THREE.Vector3(1.5, TABLET_TABLE_HEIGHT + 0.6, -4.8);
const TABLET_B_POS = new THREE.Vector3(4.0, TABLET_TABLE_HEIGHT + 0.6, -4.8);
/** CSS3D tablet DOM (px) — same aspect as TABLET_FRAME; keep in sync with .tablet-container in style.css */
const TABLET_UI_PX = { w: 1200, h: 800 };
/** 3D bezel frame around the plane (world units), 3:2 to match TABLET_UI_PX */
const TABLET_FRAME = { w: 1.56, h: 1.04, d: 0.052 };
/**
 * Default booth orbit (world units ≈ feet). Eye-level “flat” framing: camera and look-at share ~the same Y
 * so the view is across the space, not bird’s-eye. Used on load, Explore Space, and exiting tablet/card/QR/demo.
 */
const BOOTH_ORBIT_TARGET = new THREE.Vector3(0, 5.6, 0);
const CAM_HOME = new THREE.Vector3(11.5, 5.6, 16.8);
const CAM_DEMO_OFFSET = new THREE.Vector3(0, 0.4, 1.1);
/** Wall QR zoom: offset from look point into the booth (+X) with a slight Z nudge for framing. */
const CAM_QR_OFFSET = new THREE.Vector3(2.5, 0.08, 0.14);
/** Back-wall QR (above tablet B) zoom: mostly toward +Z from the wall into the booth. */
const CAM_TABLET_B_QR_OFFSET = new THREE.Vector3(0, 0.1, 2.38);
/** Camera for “card demo” — close on collaboration table */
const CAM_CARD_DEMO = new THREE.Vector3(2.4, 5.4, 6.8);
const LOOK_TABLE = new THREE.Vector3(1.0, COLLAB_TABLE_CLOTH_H - 0.02, 2.5);

const DEMO_URL = "https://aff-demo-oracle.vercel.app/";
/** Static preview on 3D tablets — `public/oracle-thumbnail.png`. */
const TABLET_THUMB_SRC = '/oracle-thumbnail.png';
/** Approx total height of `.tv-qr-wrap` in px (520 image + gap + two caption lines); used to stack wall badges above QR planes. */
const TV_QR_WRAP_LAYOUT_H_PX = 520 + 18 + 110;

const INK_SWATCHES = ['#CE0058', '#DBE825', '#68D2AD', '#516B38', '#B869D8'];
/** 5×20 ink tiles on the left wall (100 patches). Must match the `setupBooth` loop that builds them. */
const INK_PATCH_WALL = {
    cols: 20,
    rows: 5,
    x: -BOOTH_WIDTH / 2 + 0.28,
    y0: 2.4,
    z0: -5,
    pitchY: 0.5,
    pitchZ: 0.5,
};

const CARD_DRIP_VERTEX_N = 36;
const CARD_DRIP_GROW_DECAY_DEFAULT = 0.988;
const CARD_DRIP_GROW_MIN = 0.022;

function hexToRgba(hex, a) {
    let h = hex.replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length < 6) return `rgba(0,0,0,${a})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
}

function makeDripEdgeOffsets(n = CARD_DRIP_VERTEX_N) {
    return Array.from({ length: n }, () => 0.86 + Math.random() * 0.26);
}

/** Irregular wicking edge: ellipse distorted by per-vertex radius multipliers (blotting-paper silhouette). */
function inkBlobPath(ctx, px, py, prx, pry, rot, offsets) {
    const n = offsets.length;
    const pts = [];
    for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        const ex = prx * Math.cos(t);
        const ey = pry * Math.sin(t);
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        const m = offsets[i];
        pts.push({
            x: px + (c * ex - s * ey) * m,
            y: py + (s * ex + c * ey) * m,
        });
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
}

/** Migrate drips created before ink simulation fields existed. */
function ensureCardDripShape(d) {
    if (!d.offsets || d.offsets.length !== CARD_DRIP_VERTEX_N) d.offsets = makeDripEdgeOffsets();
    if (typeof d.growDecay !== 'number') d.growDecay = CARD_DRIP_GROW_DECAY_DEFAULT;
    if (typeof d.ryGrowRatio !== 'number') d.ryGrowRatio = 1.15;
    if (d.opacity == null) d.opacity = 0.98;
}

function qrCaptionInnerHTML() {
    return (
        '<img src="/qr-code.png" alt="" class="tv-qr-img" width="520" height="520" draggable="false">' +
        '<p class="tv-qr-caption"><span>Scan to get</span><span>an art oracle reading</span></p>'
    );
}

// --- State ---
let scene, camera, renderer, cssRenderer, controls, raycaster, mouse;
let tabletA, tabletB, wallLogo, tvScreen, tvQrCode, tabletBQr;
let qrWallBadgeTv, qrWallBadgeBack;
let tabletIndicator;
let tabletIndicator2;
let tabletIndicator3;
/** 'booth' | 'tablet' | 'card' | 'qr' */
let viewMode = 'booth';
let cardOverlayEl;
let cardDripCanvas;
let cardDripCtx;
let cardActiveColor = '#ce0058';
let cardDrips = [];
/** SVG `#card-flower-path` `d` + viewBox for drip clip (empty = fallback ellipse) */
let cardClipPathD = '';
let cardClipViewBox = { x: 0, y: 0, w: 248.83, h: 257.28 };
/** Fixed 2D panel with iframe — reliable interaction vs CSS3D iframe in-scene */
let demoOverlayEl;
let demoOverlayIframe;

function setupTabletIndicatorAnim() {
    for (const ind of [tabletIndicator, tabletIndicator2, tabletIndicator3]) {
        if (!ind?.element) continue;
        const arrow = ind.element.querySelector('.step-indicator__arrow');
        if (!arrow) continue;
        const towardWall = ind.element.classList.contains('step-indicator--toward-wall');
        gsap.to(arrow, {
            ...(towardWall ? { x: -12 } : { y: 10 }),
            duration: 0.7,
            ease: 'power1.inOut',
            yoyo: true,
            repeat: -1,
        });
    }
}

function setupCustomCursor() {
    const mq = window.matchMedia('(pointer: fine)');
    if (!mq.matches) return;

    const el = document.getElementById('custom-cursor');
    if (!el) return;

    document.documentElement.classList.add('has-custom-cursor');

    const isInteractiveUnder = (clientX, clientY) => {
        const under = document.elementFromPoint(clientX, clientY);
        if (!under || under === el) return false;
        return !!under.closest(
            'button, a[href], input, select, textarea, [role="button"], label, .btn, .tablet-interactive, .card-ink-swatch, iframe, .demo-overlay__backdrop, .card-demo-overlay__backdrop',
        );
    };

    const onMove = (e) => {
        const inView =
            e.clientX >= 0 &&
            e.clientX < window.innerWidth &&
            e.clientY >= 0 &&
            e.clientY < window.innerHeight;
        if (!inView) {
            el.classList.add('is-hidden');
            return;
        }
        el.classList.remove('is-hidden');
        el.style.left = `${e.clientX}px`;
        el.style.top = `${e.clientY}px`;
        if (isInteractiveUnder(e.clientX, e.clientY)) el.classList.add('is-hover');
        else el.classList.remove('is-hover');
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', () => el.classList.add('is-pressing'));
    window.addEventListener('pointerup', () => el.classList.remove('is-pressing'));
    window.addEventListener('pointercancel', () => el.classList.remove('is-pressing'));
}

function init() {
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xd4c2e6, 26, 78);
    scene.background = new THREE.Color(0xdcccf0);
    
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.copy(CAM_HOME);

    // 1. WebGL Renderer (3D)
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.domElement.id = 'webgl-canvas';
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Modern color pipeline + filmic roll-off (stable highlights)
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.6;
    document.getElementById('container').appendChild(renderer.domElement);

    setupImageBasedLighting();

    // 2. CSS3D Renderer (HTML inside 3D)
    cssRenderer = new CSS3DRenderer();
    cssRenderer.setSize(window.innerWidth, window.innerHeight);
    cssRenderer.domElement.id = 'css3d-layer';
    cssRenderer.domElement.style.position = 'absolute';
    cssRenderer.domElement.style.top = '0';
    cssRenderer.domElement.style.pointerEvents = 'none';
    document.getElementById('container').appendChild(cssRenderer.domElement);

    // 3. Controls — orbit (LMB drag), pan (RMB / two-finger), zoom (wheel / MMB)
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enableRotate = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.screenSpacePanning = true;
    controls.minDistance = 2.8;
    controls.maxDistance = 58;
    controls.minPolarAngle = 0.15;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.target.copy(BOOTH_ORBIT_TARGET);
    controls.update();

    setupLights();
    setupBooth();
    createInteractiveTable();
    createTableSpotTrackDecor();
    setupCardDemoOverlay();
    setupDemoOverlay();
    setupInteractions();
    setupCustomCursor();
    setupTabletIndicatorAnim();
    window.addEventListener('resize', onWindowResize);
    animate();
}

function setupDemoOverlay() {
    if (document.getElementById('demo-overlay')) return;
    demoOverlayEl = document.createElement('div');
    demoOverlayEl.id = 'demo-overlay';
    demoOverlayEl.className = 'demo-overlay demo-overlay--hidden';
    demoOverlayEl.setAttribute('aria-hidden', 'true');
    demoOverlayEl.innerHTML = `
        <div class="demo-overlay__backdrop" tabindex="-1"></div>
        <div class="demo-overlay__tablet" role="dialog" aria-label="Interactive demo">
            <button type="button" class="demo-overlay__close" aria-label="Close demo">&times;</button>
            <div class="demo-overlay__screen">
                <iframe class="demo-overlay__iframe" title="Unit A demo" loading="lazy"></iframe>
            </div>
        </div>
    `;
    document.body.appendChild(demoOverlayEl);
    demoOverlayIframe = demoOverlayEl.querySelector('.demo-overlay__iframe');
    const backdrop = demoOverlayEl.querySelector('.demo-overlay__backdrop');
    const closeBtn = demoOverlayEl.querySelector('.demo-overlay__close');
    closeBtn.addEventListener('click', () => setView(false));
    backdrop.addEventListener('click', () => setView(false));
}

function showDemoOverlay() {
    if (!demoOverlayEl) return;
    if (!demoOverlayIframe.src) demoOverlayIframe.src = DEMO_URL;
    demoOverlayEl.classList.remove('demo-overlay--hidden');
    demoOverlayEl.setAttribute('aria-hidden', 'false');
}

function hideDemoOverlay() {
    if (!demoOverlayEl) return;
    demoOverlayEl.classList.add('demo-overlay--hidden');
    demoOverlayEl.setAttribute('aria-hidden', 'true');
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    cssRenderer.setSize(window.innerWidth, window.innerHeight);
    syncCardDripCanvasSize();
}

/** Indoor IBL: subtle reflections / contact shading on MeshStandard without an HDR file. */
function setupImageBasedLighting() {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new RoomEnvironment();
    const { texture } = pmrem.fromScene(envScene, 0.055);
    scene.environment = texture;
    scene.environmentIntensity = 0.46;
    envScene.dispose();
    pmrem.dispose();
}

function setupLights() {
    /* Lower fill so the directional key reads; shadows stay darker vs lit areas. */
    scene.add(new THREE.AmbientLight(0xf0e8f8, 0.42));

    const hemi = new THREE.HemisphereLight(0xe8e4f5, 0x353238, 0.44);
    hemi.position.set(0, WALL_HEIGHT, 0);
    scene.add(hemi);

    const sunLight = new THREE.DirectionalLight(0xfff7ed, 1.52);
    sunLight.position.set(12, 22, 11);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.near = 1.5;
    sunLight.shadow.camera.far = 42;
    /* Tighter ortho frustum → better shadow texel density over the booth. */
    const ext = 9;
    sunLight.shadow.camera.left = -ext;
    sunLight.shadow.camera.right = ext;
    sunLight.shadow.camera.top = ext;
    sunLight.shadow.camera.bottom = -ext;
    sunLight.shadow.bias = -0.00022;
    sunLight.shadow.normalBias = 0.028;
    sunLight.shadow.radius = 2.2;
    scene.add(sunLight);

    /* Two spots flanking the table on X — cross-rake the pink cloth top from left and right. */
    const tableCx = 1.0;
    const tableCz = 2.5;
    const tableTopY = COLLAB_TABLE_CLOTH_H;
    const tableSpotTarget = new THREE.Object3D();
    tableSpotTarget.position.set(tableCx, tableTopY - 0.04, tableCz);
    scene.add(tableSpotTarget);

    const spotY = tableTopY + 1.55;
    const addTableSpot = (x) => {
        const spot = new THREE.SpotLight(0xfff6ed, 9.2, 22, 1.45, 0.09, 2);
        spot.position.set(x, spotY, tableCz);
        spot.target = tableSpotTarget;
        spot.castShadow = true;
        spot.shadow.mapSize.set(2048, 2048);
        spot.shadow.camera.near = 0.35;
        spot.shadow.camera.far = 12;
        spot.shadow.bias = -0.0001;
        spot.shadow.normalBias = 0.05;
        scene.add(spot);
    };
    addTableSpot(tableCx + TABLE_SPOT_PAIR_OFFSET_X);
    addTableSpot(tableCx - TABLE_SPOT_PAIR_OFFSET_X);
}

function createTablet(position, id) {
    const group = new THREE.Group();
    const { w: fw, h: fh, d: fd } = TABLET_FRAME;
    const frame = new THREE.Mesh(
        new RoundedBoxGeometry(fw, fh, fd, 4, 0.028),
        new THREE.MeshStandardMaterial({
            color: 0x141418,
            metalness: 0.55,
            roughness: 0.38,
            envMapIntensity: 0.65,
        }),
    );
    frame.name = "TabletTarget_" + id;
    group.add(frame);

    const el = document.createElement('div');
    el.className = 'tablet-container tablet-interactive';
    el.innerHTML = `<div class="tablet-header">Display Unit ${id}</div><img class="tablet-screen-thumb" src="${TABLET_THUMB_SRC}" alt="" width="1200" height="760" loading="lazy" decoding="async" draggable="false">`;
    const cssObj = new CSS3DObject(el);
    const s = fw / TABLET_UI_PX.w;
    cssObj.position.z = fd / 2 + 0.006;
    cssObj.scale.set(s, s, s);
    group.add(cssObj);

    group.position.copy(position);
    group.rotation.x = -0.25;
    return group;
}

function setupBooth() {
    // Floor
    const floor = new THREE.Mesh(
        new THREE.BoxGeometry(BOOTH_WIDTH, 0.2, BOOTH_DEPTH),
        new THREE.MeshStandardMaterial({
            color: 0x3b3b3b,
            roughness: 0.9,
            metalness: 0.05,
            envMapIntensity: 0.26,
        }),
    );
    floor.position.set(0, -0.1, 0);
    floor.receiveShadow = true;
    scene.add(floor);

    // Walls
    const wallMat = new THREE.MeshStandardMaterial({
        color: 0xf3c3d7,
        roughness: 0.98,
        metalness: 0,
        envMapIntensity: 0.3,
        side: THREE.DoubleSide,
    });
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(BOOTH_WIDTH, WALL_HEIGHT, 0.5), wallMat);
    backWall.position.set(0, WALL_HEIGHT / 2, -BOOTH_DEPTH / 2);
    backWall.receiveShadow = true;
    scene.add(backWall);

    const sideWall = new THREE.Mesh(new THREE.BoxGeometry(0.5, WALL_HEIGHT, BOOTH_DEPTH), wallMat);
    sideWall.position.set(-BOOTH_WIDTH / 2, WALL_HEIGHT / 2, 0);
    sideWall.receiveShadow = true;
    scene.add(sideWall);

    // Logo
    const logoEl = document.createElement('div');
    logoEl.className = 'wall-logo';
    logoEl.innerHTML = `<div class="logo-main">ART ORACLE</div><div class="logo-sub">PRESENTED BY</div><div class="logo-sub">FIT ART MARKET STUDIES</div>`;
    wallLogo = new CSS3DObject(logoEl);
    wallLogo.position.set(0, 8.5, -BOOTH_DEPTH / 2 + 0.26); 
    wallLogo.scale.set(0.012, 0.012, 0.012);
    scene.add(wallLogo);

    // TV Screen
    const tvEl = document.createElement('div');
    tvEl.className = 'tv-container tablet-interactive';
    tvEl.innerHTML = `<div class="tv-video-placeholder"><p>VIDEO FEED</p></div>`;
    tvScreen = new CSS3DObject(tvEl);
    tvScreen.position.set(-BOOTH_WIDTH / 2 + 0.26, 7.2, -0.5);
    tvScreen.rotation.y = Math.PI / 2;
    tvScreen.scale.set(0.0055, 0.0055, 0.0055);
    scene.add(tvScreen);

    const qrEl = document.createElement('div');
    qrEl.className = 'tv-qr-wrap tablet-interactive';
    qrEl.innerHTML = qrCaptionInnerHTML();
    tvQrCode = new CSS3DObject(qrEl);
    /** Beside TV: same wall (x); offset along z past the TV plane; keep in sync with .tv-qr-wrap width in style.css */
    const tvHalfZ = (1280 * 0.0055) / 2;
    const qrLayoutW = 640;
    const qrHalfZ = (qrLayoutW * 0.0022) / 2;
    const qrGap = 1.35;
    tvQrCode.position.set(-BOOTH_WIDTH / 2 + 0.26, 6.45, -0.5 + tvHalfZ + qrGap + qrHalfZ);
    tvQrCode.rotation.y = Math.PI / 2;
    tvQrCode.scale.set(0.0022, 0.0022, 0.0022);
    scene.add(tvQrCode);

    const qrBadgeScale = 0.0022;
    const qrPlaneHalfH = (TV_QR_WRAP_LAYOUT_H_PX * qrBadgeScale) / 2;
    const qrBadgeAboveGap = 28 * qrBadgeScale;
    const qrBadgeCircleHalf = (160 * qrBadgeScale) / 2;
    const qrBadgeYOffset = qrPlaneHalfH + qrBadgeAboveGap + qrBadgeCircleHalf;

    const qrTvBadgeEl = document.createElement('div');
    qrTvBadgeEl.className = 'qr-wall-badge';
    qrTvBadgeEl.innerHTML = '<div class="qr-wall-badge__circle">1</div>';
    qrWallBadgeTv = new CSS3DObject(qrTvBadgeEl);
    qrWallBadgeTv.scale.set(qrBadgeScale, qrBadgeScale, qrBadgeScale);
    qrWallBadgeTv.rotation.copy(tvQrCode.rotation);
    qrWallBadgeTv.position.set(
        tvQrCode.position.x,
        tvQrCode.position.y + qrBadgeYOffset,
        tvQrCode.position.z,
    );
    scene.add(qrWallBadgeTv);

    // Tablet Table — same material as booth walls
    const tabletTable = new THREE.Mesh(
        new RoundedBoxGeometry(5.5, 0.2, 2.5, 4, 0.05),
        wallMat,
    );
    tabletTable.position.set(2.75, TABLET_TABLE_HEIGHT, -4.75);
    tabletTable.castShadow = true;
    tabletTable.receiveShadow = true;
    scene.add(tabletTable);

    const tabletLegsPos = [[2.75 - 2.5, -4], [2.75 + 2.5, -4], [2.75 - 2.5, -5.5], [2.75 + 2.5, -5.5]];
    tabletLegsPos.forEach(p => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, TABLET_TABLE_HEIGHT, 0.1), wallMat);
        leg.position.set(p[0], TABLET_TABLE_HEIGHT / 2, p[1]);
        scene.add(leg);
    });

    const patchSize = 0.39;
    const inkPatchDisplayColor = (hex) => {
        const c = new THREE.Color(hex);
        c.lerp(new THREE.Color(0xffffff), 0.18);
        const hsl = { h: 0, s: 0, l: 0 };
        c.getHSL(hsl);
        c.setHSL(hsl.h, hsl.s * 0.96, Math.min(0.86, hsl.l + 0.03));
        return c;
    };
    const inkPatchMats = INK_SWATCHES.map(
        (hex) =>
            new THREE.MeshStandardMaterial({
                color: inkPatchDisplayColor(hex),
                roughness: 0.52,
                metalness: 0.02,
                envMapIntensity: 0.48,
            }),
    );
    for (let row = 0; row < INK_PATCH_WALL.rows; row++) {
        for (let col = 0; col < INK_PATCH_WALL.cols; col++) {
            const mat = inkPatchMats[Math.floor(Math.random() * inkPatchMats.length)];
            const patch = new THREE.Mesh(new THREE.BoxGeometry(0.05, patchSize, patchSize), mat);
            patch.position.set(
                INK_PATCH_WALL.x,
                INK_PATCH_WALL.y0 + row * INK_PATCH_WALL.pitchY,
                INK_PATCH_WALL.z0 + col * INK_PATCH_WALL.pitchZ,
            );
            patch.castShadow = true;
            scene.add(patch);
        }
    }

    tabletA = createTablet(TABLET_A_POS, "A");
    tabletB = createTablet(TABLET_B_POS, "B");
    scene.add(tabletA);
    scene.add(tabletB);

    // --- Step indicator above tablet A ---
    const indEl = document.createElement('div');
    indEl.className = 'step-indicator';
    indEl.innerHTML =
        '<div class="step-indicator__num">1</div>' +
        '<div class="step-indicator__arrow">▼</div>' +
        '<div class="step-indicator__label">Start here</div>';
    tabletIndicator = new CSS3DObject(indEl);
    tabletIndicator.scale.setScalar(0.0055);
    tabletIndicator.position.set(
        TABLET_A_POS.x,
        TABLET_A_POS.y + 1.35,
        TABLET_A_POS.z,
    );
    scene.add(tabletIndicator);

    const inkGridMidY =
        INK_PATCH_WALL.y0 + ((INK_PATCH_WALL.rows - 1) / 2) * INK_PATCH_WALL.pitchY;
    const inkGridMidZ =
        INK_PATCH_WALL.z0 + ((INK_PATCH_WALL.cols - 1) / 2) * INK_PATCH_WALL.pitchZ;
    /** Nudge into the booth (+X) so the sign sits in front of the patch wall and the arrow reads toward it. */
    const inkGridIndicatorOffsetX = 1.35;

    const ind2El = document.createElement('div');
    ind2El.className = 'step-indicator step-indicator--toward-wall';
    ind2El.innerHTML =
        '<div class="step-indicator__num">2</div>' +
        '<div class="step-indicator__arrow" aria-hidden="true">◀</div>' +
        '<div class="step-indicator__label">Booth oracle</div>';
    tabletIndicator2 = new CSS3DObject(ind2El);
    tabletIndicator2.scale.setScalar(0.0055);
    tabletIndicator2.position.set(
        INK_PATCH_WALL.x + inkGridIndicatorOffsetX,
        inkGridMidY + 1.12,
        inkGridMidZ,
    );
    scene.add(tabletIndicator2);

    const ind3El = document.createElement('div');
    ind3El.className = 'step-indicator';
    ind3El.innerHTML =
        '<div class="step-indicator__num">3</div>' +
        '<div class="step-indicator__arrow">▼</div>' +
        '<div class="step-indicator__label">magical reveal</div>';
    tabletIndicator3 = new CSS3DObject(ind3El);
    tabletIndicator3.scale.setScalar(0.0055);
    tabletIndicator3.position.set(LOOK_TABLE.x, COLLAB_TABLE_CLOTH_H + 1.5, LOOK_TABLE.z);
    scene.add(tabletIndicator3);

    const qrBEl = document.createElement('div');
    qrBEl.className = 'tv-qr-wrap tablet-interactive';
    qrBEl.innerHTML = qrCaptionInnerHTML();
    tabletBQr = new CSS3DObject(qrBEl);
    /** Back wall, above tablet area: +X from logo, clamped so the plane stays inside the wall (see `.tv-qr-wrap` width). */
    const qrBackScale = 0.0022;
    const qrBackLayoutW = 640;
    tabletBQr.scale.set(qrBackScale, qrBackScale, qrBackScale);
    const qrHalfWWorld = (qrBackLayoutW * qrBackScale) / 2;
    const wallHalfW = BOOTH_WIDTH / 2;
    const wallEdgeInset = 0.32;
    const maxCenterX = wallHalfW - qrHalfWWorld - wallEdgeInset;
    const preferredX = TABLET_B_POS.x + 0.95;
    tabletBQr.position.set(Math.min(maxCenterX, preferredX), 6.42, -BOOTH_DEPTH / 2 + 0.26);
    scene.add(tabletBQr);

    const qrBackBadgeEl = document.createElement('div');
    qrBackBadgeEl.className = 'qr-wall-badge';
    qrBackBadgeEl.innerHTML = '<div class="qr-wall-badge__circle">1</div>';
    qrWallBadgeBack = new CSS3DObject(qrBackBadgeEl);
    qrWallBadgeBack.scale.set(qrBackScale, qrBackScale, qrBackScale);
    qrWallBadgeBack.position.set(
        tabletBQr.position.x,
        tabletBQr.position.y + qrBadgeYOffset,
        tabletBQr.position.z,
    );
    scene.add(qrWallBadgeBack);
}

function createInteractiveTable() {
    const clothMat = new THREE.MeshStandardMaterial({
        color: 0xee829d,
        roughness: 0.92,
        metalness: 0,
        envMapIntensity: 0.38,
    });
    const tableMesh = new THREE.Mesh(
        new THREE.BoxGeometry(TABLE_SIZE.w, COLLAB_TABLE_CLOTH_H, TABLE_SIZE.d),
        clothMat,
    );
    tableMesh.position.set(1.0, COLLAB_TABLE_CLOTH_H / 2, 2.5);
    tableMesh.receiveShadow = true;
    tableMesh.castShadow = true;
    scene.add(tableMesh);

    createDecorativeInkBottles();
}

/** Decorative track + two full-height tubes (no lights) — same X spacing as the real table spots. */
function createTableSpotTrackDecor() {
    const tableCx = 1.0;
    const tableCz = 2.5;
    const ox = TABLE_SPOT_PAIR_OFFSET_X;

    const trackMat = new THREE.MeshStandardMaterial({
        color: 0x1c1c20,
        roughness: 0.9,
        metalness: 0.12,
        envMapIntensity: 0.32,
    });

    const track = new THREE.Mesh(new THREE.BoxGeometry(BOOTH_WIDTH, 0.14, 0.12), trackMat);
    track.position.set(0, WALL_HEIGHT - 0.09, tableCz);
    track.castShadow = true;
    track.receiveShadow = true;
    scene.add(track);

    const rTube = 0.19;
    const hTube = 0.26;
    const tubeGeo = new THREE.CylinderGeometry(rTube, rTube, hTube, 22);
    const trackBottomY = WALL_HEIGHT - 0.09 - 0.07;
    const tubeCenterY = trackBottomY - hTube / 2;
    for (const sign of [-1, 1]) {
        const tube = new THREE.Mesh(tubeGeo, trackMat);
        tube.position.set(tableCx + sign * ox, tubeCenterY, tableCz);
        tube.castShadow = true;
        tube.receiveShadow = true;
        scene.add(tube);
    }
}

/** Non-interactive ink bottles: outer transmission glass + inner colored ink volume. */
function createDecorativeInkBottles() {
    const s = 3.25;
    const topY = COLLAB_TABLE_CLOTH_H;
    const tableCx = 1.0;
    const tableCz = 2.5;
    const zRow = tableCz;
    const insetX = 0.95;
    const xMin = tableCx - TABLE_SIZE.w / 2 + insetX;
    const xMax = tableCx + TABLE_SIZE.w / 2 - insetX;

    const segs = 28;
    const hBody = 0.2 * s;
    const rTop = 0.07 * s;
    const rBot = 0.088 * s;

    const inkScale = 0.84;
    const fillH = hBody * 0.74;
    const inkBottomLift = 0.012 * s;

    const bottleGlassMat = new THREE.MeshPhysicalMaterial({
        color: 0xf8f9fc,
        metalness: 0,
        roughness: 0.06,
        transmission: 0.94,
        thickness: 0.22 * s,
        ior: 1.5,
        envMapIntensity: 0.92,
        transparent: true,
        side: THREE.DoubleSide,
    });

    const inkMat = (hex) => {
        const c = new THREE.Color(hex);
        c.multiplyScalar(0.88);
        return new THREE.MeshStandardMaterial({
            color: c,
            roughness: 0.42,
            metalness: 0,
            envMapIntensity: 0.32,
        });
    };

    for (let i = 0; i < INK_SWATCHES.length; i++) {
        const t = INK_SWATCHES.length === 1 ? 0.5 : i / (INK_SWATCHES.length - 1);
        const x = xMin + t * (xMax - xMin);
        const z = zRow;
        const g = new THREE.Group();
        g.position.set(x, topY, z);

        const inkGeom = new THREE.CylinderGeometry(
            rTop * inkScale,
            rBot * inkScale,
            fillH,
            segs,
        );
        const ink = new THREE.Mesh(inkGeom, inkMat(INK_SWATCHES[i]));
        ink.position.y = inkBottomLift + fillH / 2;
        ink.castShadow = true;
        ink.receiveShadow = true;
        ink.raycast = () => {};

        const glassGeom = new THREE.CylinderGeometry(rTop, rBot, hBody, segs);
        const glass = new THREE.Mesh(glassGeom, bottleGlassMat);
        glass.position.y = hBody / 2;
        glass.castShadow = false;
        glass.receiveShadow = true;
        glass.raycast = () => {};

        g.add(ink, glass);
        scene.add(g);
    }
}

function setupCardDemoOverlay() {
    if (document.getElementById('card-demo-overlay')) return;
    const root = document.createElement('div');
    root.id = 'card-demo-overlay';
    root.className = 'card-demo-overlay';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
        <div class="card-demo-overlay__backdrop" tabindex="-1"></div>
        <div class="card-demo-overlay__panel">
            <div class="card-demo-overlay__stage">
                <img class="card-demo-overlay__flower" src="/card-flower.svg" alt="" width="200" height="200" />
                <canvas id="card-drip-canvas" width="400" height="400" aria-label="Paint on card"></canvas>
            </div>
            <p class="card-demo-overlay__hint">Choose the colors you like and drip them onto the card to reveal magical reading result.</p>
            <div id="card-ink-ui"></div>
            <button type="button" class="card-demo-overlay__close" id="card-demo-close">Back to booth</button>
        </div>
    `;
    document.body.appendChild(root);
    cardOverlayEl = root;
    cardDripCanvas = root.querySelector('#card-drip-canvas');
    cardDripCtx = cardDripCanvas.getContext('2d');

    const cardInk = root.querySelector('#card-ink-ui');
    INK_SWATCHES.forEach((c) => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'card-ink-swatch';
        sw.style.background = c;
        sw.dataset.color = c;
        if (c === cardActiveColor) sw.classList.add('card-ink-swatch--active');
        sw.addEventListener('click', (e) => {
            e.stopPropagation();
            cardActiveColor = c;
            cardInk.querySelectorAll('.card-ink-swatch').forEach((b) => b.classList.remove('card-ink-swatch--active'));
            sw.classList.add('card-ink-swatch--active');
        });
        cardInk.appendChild(sw);
    });

    root.querySelector('#card-demo-close').addEventListener('click', () => exitCardDemo());
    root.querySelector('.card-demo-overlay__backdrop').addEventListener('click', () => exitCardDemo());

    cardDripCanvas.addEventListener('pointerdown', onCardCanvasPointer);

    void loadCardFlowerClipFromSvg().then(() => {
        if (cardOverlayEl?.classList.contains('card-demo-overlay--visible')) {
            syncCardDripCanvasSize();
            redrawCardCanvas();
        }
    });
}

async function loadCardFlowerClipFromSvg() {
    try {
        const res = await fetch('/card-flower.svg');
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const pathEl = doc.querySelector('#card-flower-path');
        if (!pathEl) return;
        const d = pathEl.getAttribute('d');
        if (!d || !d.trim()) return;
        cardClipPathD = d.trim();
        const svg = doc.querySelector('svg');
        const vb = svg?.getAttribute('viewBox');
        if (vb) {
            const parts = vb.trim().split(/[\s,]+/).map(Number);
            if (parts.length >= 4 && parts.every((n) => !Number.isNaN(n))) {
                cardClipViewBox = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
            }
        }
    } catch {
        cardClipPathD = '';
    }
}

function syncCardDripCanvasSize() {
    if (!cardDripCanvas || !cardOverlayEl || !cardOverlayEl.classList.contains('card-demo-overlay--visible')) return;
    const stage = cardOverlayEl.querySelector('.card-demo-overlay__stage');
    if (!stage) return;
    const w = Math.max(200, Math.floor(stage.clientWidth));
    const h = Math.max(200, Math.floor(stage.clientHeight));
    if (cardDripCanvas.width === w && cardDripCanvas.height === h) return;
    const oldW = cardDripCanvas.width;
    const oldH = cardDripCanvas.height;
    if (oldW > 0 && oldH > 0) {
        const sx = w / oldW;
        const sy = h / oldH;
        for (const d of cardDrips) {
            d.x *= sx;
            d.y *= sy;
            d.rx *= sx;
            d.ry *= sy;
            d.maxRx *= sx;
            d.maxRy *= sy;
            if (typeof d.grow === 'number') d.grow *= (sx + sy) / 2;
        }
    }
    cardDripCanvas.width = w;
    cardDripCanvas.height = h;
    redrawCardCanvas();
}

function buildFlowerClip(ctx, w, h) {
    const s = Math.min(w, h) / 200;
    const cx = w / 2;
    const cy = h / 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const px = cx + Math.cos(a) * 32 * s;
        const py = cy + Math.sin(a) * 32 * s;
        ctx.ellipse(px, py, 28 * s, 44 * s, a, 0, Math.PI * 2);
    }
    ctx.arc(cx, cy, 22 * s, 0, Math.PI * 2);
}

function redrawCardCanvas() {
    if (!cardDripCtx || !cardDripCanvas) return;
    const w = cardDripCanvas.width;
    const h = cardDripCanvas.height;
    const vb = cardClipViewBox;
    let useSvgClip = !!cardClipPathD;
    let Tx = 0;
    let Ty = 0;
    let scale = 1;

    cardDripCtx.save();
    cardDripCtx.setTransform(1, 0, 0, 1, 0, 0);
    cardDripCtx.clearRect(0, 0, w, h);

    if (useSvgClip) {
        scale = Math.min(w / vb.w, h / vb.h);
        Tx = (w - vb.w * scale) / 2 - vb.x * scale;
        Ty = (h - vb.h * scale) / 2 - vb.y * scale;
        cardDripCtx.translate(Tx, Ty);
        cardDripCtx.scale(scale, scale);
        try {
            cardDripCtx.clip(new Path2D(cardClipPathD));
        } catch {
            cardDripCtx.restore();
            cardDripCtx.save();
            useSvgClip = false;
            cardDripCtx.beginPath();
            buildFlowerClip(cardDripCtx, w, h);
            cardDripCtx.clip();
        }
    } else {
        cardDripCtx.beginPath();
        buildFlowerClip(cardDripCtx, w, h);
        cardDripCtx.clip();
    }

    for (const d of cardDrips) {
        ensureCardDripShape(d);
        cardDripCtx.save();
        const pxU = useSvgClip ? (d.x - Tx) / scale : d.x;
        const pyU = useSvgClip ? (d.y - Ty) / scale : d.y;
        const prxU = useSvgClip ? d.rx / scale : d.rx;
        const pryU = useSvgClip ? d.ry / scale : d.ry;

        const opacity = d.opacity ?? 0.98;
        const offs = d.offsets;
        const rOuter = Math.max(prxU, pryU) * 1.1;
        const grad = cardDripCtx.createRadialGradient(pxU, pyU, 0, pxU, pyU, rOuter);
        const hc = d.color;
        grad.addColorStop(0, hexToRgba(hc, 0.96 * opacity));
        grad.addColorStop(0.35, hexToRgba(hc, 0.6 * opacity));
        grad.addColorStop(0.62, hexToRgba(hc, 0.26 * opacity));
        grad.addColorStop(0.88, hexToRgba(hc, 0.05 * opacity));
        grad.addColorStop(1, hexToRgba(hc, 0));

        const spreadT = Math.min(1, d.rx / d.maxRx);
        cardDripCtx.fillStyle = grad;
        cardDripCtx.globalAlpha = 1;
        cardDripCtx.shadowColor = hexToRgba(hc, 0.32 * (1 - spreadT * 0.35));
        cardDripCtx.shadowBlur = 5 + spreadT * 14;
        cardDripCtx.shadowOffsetX = 0;
        cardDripCtx.shadowOffsetY = 0;

        inkBlobPath(cardDripCtx, pxU, pyU, prxU, pryU, d.rot, offs);
        cardDripCtx.fill();
        cardDripCtx.shadowBlur = 0;
        cardDripCtx.shadowColor = 'transparent';
        cardDripCtx.restore();
    }
    cardDripCtx.restore();
}

function onCardCanvasPointer(e) {
    if (viewMode !== 'card') return;
    e.preventDefault();
    const rect = cardDripCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * cardDripCanvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * cardDripCanvas.height;
    cardDrips.push({
        x,
        y,
        rx: (2.6 + Math.random() * 1.1) * 9,
        ry: (2.9 + Math.random() * 1.1) * 9,
        rot: Math.random() * Math.PI * 2,
        maxRx: (18 + Math.random() * 28) * 9,
        maxRy: (22 + Math.random() * 32) * 9,
        color: cardActiveColor,
        opacity: 0.98,
        grow: 0.82 + Math.random() * 0.78,
        growDecay: 0.987 + Math.random() * 0.005,
        ryGrowRatio: 1.1 + Math.random() * 0.16,
        offsets: makeDripEdgeOffsets(),
    });
}

function abortQrZoomToBooth() {
    if (viewMode !== 'qr') return;
    gsap.killTweensOf(camera.position);
    gsap.killTweensOf(controls.target);
    viewMode = 'booth';
    controls.enabled = true;
    renderer.domElement.style.pointerEvents = 'auto';
    cssRenderer.domElement.style.pointerEvents = 'none';
    updateNavButtons();
}

function enterQrZoom(qrObject, camOffset = CAM_QR_OFFSET) {
    if (viewMode !== 'booth') return;
    silentlyLeaveCardOverlay();
    gsap.killTweensOf(camera.position);
    gsap.killTweensOf(controls.target);
    viewMode = 'qr';
    controls.enabled = false;
    renderer.domElement.style.pointerEvents = 'none';
    cssRenderer.domElement.style.pointerEvents = 'auto';

    const look = new THREE.Vector3();
    qrObject.getWorldPosition(look);
    const pos = look.clone().add(camOffset);

    gsap.to(camera.position, {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        duration: 1.35,
        ease: 'power2.inOut',
    });
    gsap.to(controls.target, {
        x: look.x,
        y: look.y,
        z: look.z,
        duration: 1.35,
        ease: 'power2.inOut',
    });
    updateNavButtons();
}

function exitQrZoom() {
    if (viewMode !== 'qr') return;
    viewMode = 'booth';
    controls.enabled = true;
    renderer.domElement.style.pointerEvents = 'auto';
    cssRenderer.domElement.style.pointerEvents = 'none';

    gsap.to(camera.position, { x: CAM_HOME.x, y: CAM_HOME.y, z: CAM_HOME.z, duration: 1.35, ease: 'power2.inOut' });
    gsap.to(controls.target, {
        x: BOOTH_ORBIT_TARGET.x,
        y: BOOTH_ORBIT_TARGET.y,
        z: BOOTH_ORBIT_TARGET.z,
        duration: 1.35,
        ease: 'power2.inOut',
    });
    updateNavButtons();
}

function enterCardDemo() {
    if (viewMode === 'card') return;
    exitTabletDemoOnly();
    abortQrZoomToBooth();
    viewMode = 'card';
    controls.enabled = false;
    cssRenderer.domElement.style.pointerEvents = 'none';

    gsap.to(camera.position, {
        x: CAM_CARD_DEMO.x,
        y: CAM_CARD_DEMO.y,
        z: CAM_CARD_DEMO.z,
        duration: 1.35,
        ease: 'power2.inOut',
        onComplete: () => {
            cardOverlayEl.classList.add('card-demo-overlay--visible');
            cardOverlayEl.setAttribute('aria-hidden', 'false');
            requestAnimationFrame(() => {
                syncCardDripCanvasSize();
                redrawCardCanvas();
            });
        },
    });
    gsap.to(controls.target, {
        x: LOOK_TABLE.x,
        y: LOOK_TABLE.y,
        z: LOOK_TABLE.z,
        duration: 1.35,
        ease: 'power2.inOut',
    });

    updateNavButtons();
}

function exitTabletDemoOnly() {
    if (viewMode !== 'tablet') return;
    viewMode = 'booth';
    hideDemoOverlay();
    controls.enabled = true;
    renderer.domElement.style.pointerEvents = 'auto';
    cssRenderer.domElement.style.pointerEvents = 'none';
}

function exitCardDemo() {
    if (viewMode !== 'card') return;
    viewMode = 'booth';
    cardOverlayEl.classList.remove('card-demo-overlay--visible');
    cardOverlayEl.setAttribute('aria-hidden', 'true');
    cardDrips.length = 0;
    if (cardDripCtx) {
        cardDripCtx.clearRect(0, 0, cardDripCanvas.width, cardDripCanvas.height);
    }
    controls.enabled = true;
    renderer.domElement.style.pointerEvents = 'auto';
    cssRenderer.domElement.style.pointerEvents = 'none';

    gsap.to(camera.position, { x: CAM_HOME.x, y: CAM_HOME.y, z: CAM_HOME.z, duration: 1.35, ease: 'power2.inOut' });
    gsap.to(controls.target, {
        x: BOOTH_ORBIT_TARGET.x,
        y: BOOTH_ORBIT_TARGET.y,
        z: BOOTH_ORBIT_TARGET.z,
        duration: 1.35,
        ease: 'power2.inOut',
    });
    updateNavButtons();
}

function updateNavButtons() {
    const btnBooth = document.getElementById('viewBooth');
    const btnDemo = document.getElementById('viewDemo');
    const btnCard = document.getElementById('viewCardDemo');
    const boothActive = viewMode === 'booth';
    const tabletActive = viewMode === 'tablet';
    const cardActive = viewMode === 'card';
    if (btnBooth) btnBooth.className = boothActive ? 'btn btn-active' : 'btn';
    if (btnDemo) btnDemo.className = tabletActive ? 'btn btn-active' : 'btn';
    if (btnCard) btnCard.className = cardActive ? 'btn btn-active' : 'btn';
}

/** Tablet iframe demo zoom */
function silentlyLeaveCardOverlay() {
    if (viewMode !== 'card') return;
    viewMode = 'booth';
    cardOverlayEl.classList.remove('card-demo-overlay--visible');
    cardOverlayEl.setAttribute('aria-hidden', 'true');
    cardDrips.length = 0;
    if (cardDripCtx && cardDripCanvas) {
        cardDripCtx.clearRect(0, 0, cardDripCanvas.width, cardDripCanvas.height);
    }
}

function setView(toDemo, targetGroup = null) {
    if (toDemo && !targetGroup) return;
    if (toDemo) silentlyLeaveCardOverlay();
    if (toDemo) abortQrZoomToBooth();

    viewMode = toDemo ? 'tablet' : 'booth';
    controls.enabled = !toDemo;
    const targetPos = new THREE.Vector3();
    const targetLook = new THREE.Vector3();

    if (toDemo && targetGroup) {
        targetPos.copy(targetGroup.position).add(CAM_DEMO_OFFSET);
        targetLook.copy(targetGroup.position);
        renderer.domElement.style.pointerEvents = 'none';
        cssRenderer.domElement.style.pointerEvents = 'auto';
    } else {
        hideDemoOverlay();
        targetPos.copy(CAM_HOME);
        targetLook.copy(BOOTH_ORBIT_TARGET);
        renderer.domElement.style.pointerEvents = 'auto';
        cssRenderer.domElement.style.pointerEvents = 'none';
    }

    gsap.to(camera.position, {
        x: targetPos.x,
        y: targetPos.y,
        z: targetPos.z,
        duration: 1.5,
        ease: 'power2.inOut',
        onComplete: () => {
            if (viewMode === 'tablet') showDemoOverlay();
        },
    });
    gsap.to(controls.target, { x: targetLook.x, y: targetLook.y, z: targetLook.z, duration: 1.5, ease: 'power2.inOut' });

    updateNavButtons();
}

function setupInteractions() {
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    window.addEventListener('mousedown', (e) => {
        if (viewMode === 'card' || viewMode === 'tablet' || viewMode === 'qr') return;
        if (e.target.closest('.ui-layer')) return;

        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);

        const hitTablets = raycaster.intersectObjects([tabletA, tabletB], true);
        if (hitTablets.length > 0) {
            setView(true, hitTablets[0].object.parent);
        }
    });

    const btnDemo = document.getElementById('viewDemo');
    const btnBooth = document.getElementById('viewBooth');
    const btnCard = document.getElementById('viewCardDemo');
    if (btnDemo)
        btnDemo.onclick = () => {
            silentlyLeaveCardOverlay();
            setView(true, tabletA);
        };
    if (btnBooth)
        btnBooth.onclick = () => {
            if (viewMode === 'card') exitCardDemo();
            else if (viewMode === 'qr') exitQrZoom();
            else setView(false);
        };
    if (btnCard) btnCard.onclick = () => enterCardDemo();

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (viewMode === 'tablet') setView(false);
        else if (viewMode === 'qr') exitQrZoom();
    });

    const bindQrZoom = (qrObj, offset) => {
        if (!qrObj?.element) return;
        qrObj.element.addEventListener('click', (e) => {
            if (viewMode !== 'booth') return;
            e.stopPropagation();
            enterQrZoom(qrObj, offset);
        });
    };
    bindQrZoom(tvQrCode, CAM_QR_OFFSET);
    bindQrZoom(tabletBQr, CAM_TABLET_B_QR_OFFSET);
}

function updateOcclusion() {
    const isBehind = camera.position.z < -6.1 || camera.position.x < -6.1;
    [wallLogo, tabletA, tabletB, tvScreen, tvQrCode, tabletBQr, qrWallBadgeTv, qrWallBadgeBack, tabletIndicator, tabletIndicator2, tabletIndicator3].forEach(
        (obj) => {
            if (obj && obj.element) obj.element.style.visibility = isBehind ? 'hidden' : 'visible';
        },
    );
}

function animate() {
    requestAnimationFrame(animate);
    if (viewMode === 'card' && cardDrips.length > 0) {
        let dirty = false;
        for (const d of cardDrips) {
            ensureCardDripShape(d);
            if (typeof d.grow !== 'number') d.grow = 21.6;
            if (d.rx < d.maxRx && d.ry < d.maxRy && d.grow > CARD_DRIP_GROW_MIN) {
                d.grow *= d.growDecay ?? CARD_DRIP_GROW_DECAY_DEFAULT;
                d.rx += d.grow;
                d.ry += d.grow * (d.ryGrowRatio ?? 1.18);
                dirty = true;
            }
        }
        if (dirty) redrawCardCanvas();
    }
    controls.update();
    updateOcclusion();
    renderer.render(scene, camera);
    cssRenderer.render(scene, camera);
}

init();