(function (root) {
    'use strict';

    // Close two-pixel gaps in the background mask: expand, then shrink.
    function morph(mask, width, height, expand) {
        const horizontal = new Uint8Array(mask.length);
        const result = new Uint8Array(mask.length);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            let value = expand ? 0 : 1;
            for (let dx = -2; dx <= 2; dx++) {
                const xx = x + dx;
                const pixel = xx < 0 || xx >= width ? 1 : mask[y * width + xx];
                value = expand ? value | pixel : value & pixel;
            }
            horizontal[y * width + x] = value;
        }
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            let value = expand ? 0 : 1;
            for (let dy = -2; dy <= 2; dy++) {
                const yy = y + dy;
                const pixel = yy < 0 || yy >= height ? 1 : horizontal[yy * width + x];
                value = expand ? value | pixel : value & pixel;
            }
            result[y * width + x] = value;
        }
        return result;
    }

    function maskBackgroundPixels(imageData) {
        const { data, width, height } = imageData;
        if (!width || !height) return imageData;
        const counts = new Map();
        function count(x, y) {
            const offset = (y * width + x) * 4;
            if (data[offset + 3] < 128) return;
            const rgb = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
            counts.set(rgb, (counts.get(rgb) || 0) + 1);
        }
        for (let x = 0; x < width; x++) { count(x, 0); if (height > 1) count(x, height - 1); }
        for (let y = 1; y < height - 1; y++) { count(0, y); if (width > 1) count(width - 1, y); }
        if (!counts.size) return imageData;
        const rgb = [...counts].reduce((best, entry) => entry[1] > best[1] ? entry : best)[0];
        const red = rgb >> 16, green = rgb >> 8 & 255, blue = rgb & 255;
        const background = new Uint8Array(width * height);
        const queue = new Int32Array(width * height);
        let head = 0, tail = 0;
        function visit(index) {
            if (background[index]) return;
            const offset = index * 4;
            if (data[offset + 3] >= 128 && (
                Math.abs(data[offset] - red) > 18 ||
                Math.abs(data[offset + 1] - green) > 18 ||
                Math.abs(data[offset + 2] - blue) > 18)) return;
            background[index] = 1;
            queue[tail++] = index;
        }
        for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
        for (let y = 1; y < height - 1; y++) { visit(y * width); visit(y * width + width - 1); }
        while (head < tail) {
            const index = queue[head++];
            const x = index % width;
            if (x) visit(index - 1);
            if (x + 1 < width) visit(index + 1);
            if (index >= width) visit(index - width);
            if (index + width < background.length) visit(index + width);
        }
        const closed = morph(morph(background, width, height, true), width, height, false);
        for (let index = 0; index < closed.length; index++) if (closed[index]) data[index * 4 + 3] = 0;
        return imageData;
    }

    if (typeof module === 'object' && module.exports) module.exports = { maskBackgroundPixels };
    else (root.ESPIO ||= {}).maskBackgroundPixels = maskBackgroundPixels;
})(globalThis);
