import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const root = path.dirname(fileURLToPath(import.meta.url));
const threeModule = path.resolve(root, 'node_modules/three/build/three.module.js');

if (!fs.existsSync(threeModule)) {
    // eslint-disable-next-line no-console
    console.error(
        '\n[virtual-booth] Expected Three.js at:\n  ',
        threeModule,
        '\nRun:  cd',
        root,
        '&& npm install\n',
    );
}

export default defineConfig({
    root,
    /** Root deploy (e.g. Vercel `*.vercel.app`); change if using a subpath. */
    base: '/',
    publicDir: 'public',
    resolve: {
        // Bare `three` only — `three/addons/...` still uses package exports.
        alias: [{ find: /^three$/, replacement: threeModule }],
    },
    optimizeDeps: {
        include: ['three', 'gsap'],
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        assetsDir: 'assets',
        sourcemap: false,
    },
});
