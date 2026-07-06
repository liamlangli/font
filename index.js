const utils = require('./lib/utils');
const opentype = require('opentype.js');
const exec = require('child_process').exec;
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const assert = require('assert');
const zlib = require('zlib');
const sharp = require('sharp');

const defaultCharset = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~".split('');
const controlChars = ['\n', '\r', '\t'];

const binaryLookup = {
    darwin: 'msdfgen.osx',
    darwin_arm64: 'msdfgen.osx',
    win32: 'msdfgen.exe',
    linux: 'msdfgen.linux',
    linux_arm64: 'msdfgen.linux'
};

module.exports = generateBMFont;

/**
 * Creates a BMFont compatible bitmap font of signed distance fields from a font file
 *
 * @param {string|Buffer} fontPath - Path or Buffer for the input ttf/otf/woff font
 * @param {Object} opt - Options object for generating bitmap font (Optional) :
 *            outputType : font file format Avaliable: xml(default), json, txt
 *            filename : filename of both font file and font textures
 *            fontSize : font size for generated textures (default 42)
 *            charset : charset in generated font, could be array or string (default is Western)
 *            textureWidth : Preferred width used to estimate the single generated texture
 *            textureHeight : Preferred height used to estimate the single generated texture
 *            distanceRange : distance range for computing signed distance field
 *            fieldType : "msdf"(default), "sdf", "psdf"
 *            imageType : generated texture image format: "webp"(default) or "png"
 *            roundDecimal  : rounded digits of the output font file. (Defaut is null)
 *            smartSize : shrink atlas to the smallest practical single texture (Default: true)
 *            pot : atlas size shall be power of 2 (Default: false)
 *            square : atlas size shall be square (Default: false)
 *            rot : allow 90-degree rotation while packing (Default: false)
 *            rtl : use RTL charators fix (Default: false)
 * @param {function(string, Array.<Object>, Object)} callback - Callback funtion(err, textures, font)
 *
 */
function generateBMFont(fontPath, opt, callback) {
    if (typeof opt === 'function') {
        callback = opt;
        opt = {};
    }

    const lookupKey = process.arch === "arm64" ? `${process.platform}_${process.arch}` : process.platform;

    const binName = binaryLookup[lookupKey];

    assert.ok(binName, `No msdfgen binary for platform ${lookupKey}.`);
    assert.ok(fontPath, 'must specify a font path');
    assert.ok(typeof fontPath === 'string' || fontPath instanceof Buffer, 'font must be string path or Buffer');
    assert.ok(opt.filename || !(fontPath instanceof Buffer), 'must specify filename if font is a Buffer');
    assert.ok(callback, 'missing callback')
    assert.ok(typeof callback === 'function', 'expected callback to be a function');
    assert.ok(!opt.textureSize || opt.textureSize.length === 2, 'textureSize format shall be: width,height');

    // Set fallback output path to font path
    let fontDir = typeof fontPath === 'string' ? path.dirname(fontPath) : '';
    const binaryPath = path.join(__dirname, 'bin', lookupKey, binName);

    // const reuse = (typeof opt.reuse === 'boolean' || typeof opt.reuse === 'undefined') ? {} : opt.reuse.opt;
    let reuse, cfg = {};
    if (typeof opt.reuse !== 'undefined' && typeof opt.reuse !== 'boolean') {
        if (!fs.existsSync(opt.reuse)) {
            console.log('Creating cfg file : ' + opt.reuse);
            reuse = {};
        } else {
            console.log('Loading cfg file : ' + opt.reuse);
            cfg = JSON.parse(fs.readFileSync(opt.reuse, 'utf8'));
            reuse = cfg.opt;
        }
    } else reuse = {};
    const outputType = opt.outputType = utils.valueQueue([opt.outputType, reuse.outputType, "xml"]);
    let filename = utils.valueQueue([opt.filename, reuse.filename]);
    const distanceRange = opt.distanceRange = utils.valueQueue([opt.distanceRange, reuse.distanceRange, 4]);
    const fontSize = opt.fontSize = utils.valueQueue([opt.fontSize, reuse.fontSize, 42]);
    const fontSpacing = opt.fontSpacing = utils.valueQueue([opt.fontSpacing, reuse.fontSpacing, [0, 0]]);
    const pad = distanceRange >> 1;
    const fontPadding = opt.fontPadding = utils.valueQueue([opt.fontPadding, reuse.fontPadding, [pad, pad, pad, pad]]);
    const textureWidth = opt.textureWidth = utils.valueQueue([opt.textureSize || reuse.textureSize, [512, 512]])[0];
    const textureHeight = opt.textureHeight = utils.valueQueue([opt.textureSize || reuse.textureSize, [512, 512]])[1];
    const texturePadding = opt.texturePadding = utils.valueQueue([opt.texturePadding, reuse.texturePadding, 1]);
    const border = opt.border = utils.valueQueue([opt.border, reuse.border, 0]);
    const fieldType = opt.fieldType = utils.valueQueue([opt.fieldType, reuse.fieldType, 'msdf']);
    const imageType = opt.imageType = utils.valueQueue([opt.imageType, reuse.imageType, 'webp']);
    const roundDecimal = opt.roundDecimal = utils.valueQueue([opt.roundDecimal, reuse.roundDecimal]); // if no roudDecimal option, left null as-is
    const smartSize = opt.smartSize = utils.valueQueue([opt.smartSize, reuse.smartSize, true]);
    const pot = opt.pot = utils.valueQueue([opt.pot, reuse.pot, false]);
    const square = opt.square = utils.valueQueue([opt.square, reuse.square, false]);
    const debug = opt.vector || false;
    const tolerance = opt.tolerance = utils.valueQueue([opt.tolerance, reuse.tolerance, 0]);
    const allowRotation = opt.rot = utils.valueQueue([opt.rot, reuse.rot, false]);
    let charset = opt.charset = (typeof opt.charset === 'string' ? Array.from(opt.charset) : opt.charset) || reuse.charset || defaultCharset;

    // TODO: Validate options
    if (fieldType !== 'msdf' && fieldType !== 'sdf' && fieldType !== 'psdf' && fieldType !== 'mtsdf') {
        throw new TypeError('fieldType must be one of msdf, sdf, or psdf');
    }
    if (imageType !== 'webp' && imageType !== 'png') {
        throw new TypeError('imageType must be one of webp or png');
    }

    const font = typeof fontPath === 'string'
        ? opentype.parse(utils.bufferToArrayBuffer(fs.readFileSync(fontPath)))
        : opentype.parse(utils.bufferToArrayBuffer(fontPath));

    if (font.outlinesFormat !== 'truetype' && font.outlinesFormat !== 'cff') {
        throw new TypeError('must specify a truetype font (ttf, otf, woff)');
    }
    const packer = new ShelfPacker(textureWidth, textureHeight, texturePadding, {
        smart: smartSize,
        pot,
        square,
        allowRotation,
        border
    });
    const chars = [];

    charset = charset.filter((e, i, self) => {
        return (i == self.indexOf(e)) && (!controlChars.includes(e));
    }); // Remove duplicate & control chars

    const os2 = font.tables.os2;
    const baseline = os2.sTypoAscender * (fontSize / font.unitsPerEm) + (distanceRange >> 1);

    const fontface = typeof fontPath === 'string' ? path.basename(fontPath, path.extname(fontPath)) : filename;

    if (!filename) {
        filename = fontface;
        console.log(`Use font-face as filename : ${filename}`);
    } else {
        if (opt.filename) fontDir = path.dirname(opt.filename);
        filename = opt.filename = path.basename(filename, path.extname(filename));
    }

    // Initialize settings
    let settings = {};
    settings.opt = JSON.parse(JSON.stringify(opt));
    delete settings.opt['reuse']; // prune previous settings
    let pages = [];

    const progress = createProgress(charset.length);
    progress.start();

    mapLimit(charset, 15, (char, cb) => {
        generateImage({
            binaryPath,
            font,
            char,
            fontSize,
            fieldType,
            distanceRange,
            roundDecimal,
            debug,
            tolerance
        }, (err, res) => {
            if (err) return cb(err);
            progress.increment();
            cb(null, res);
        });
    }, async (err, results) => {
        if (err) return callback(err);
        progress.stop();

        try {
            packer.addArray(results);
        } catch (error) {
            return callback(error);
        }
        const textures = packer.bins.map(async (bin, index) => {
            let svg = "";
            let texname = "";
            let fillColor = fieldType === "mtsdf" ? 0x000000ff : 0x00000000;
            let img = createImage(bin.width, bin.height, fillColor);
            if (index > pages.length - 1) {
                texname = filename;
                pages.push(`${texname}.${imageType}`);
            } else {
                texname = path.basename(pages[index], path.extname(pages[index]));
            }
            bin.rects.forEach(rect => {
                if (rect.data.imageData) {
                    if (rect.rot) {
                        rect.data.imageData = rotateImage90(rect.data.imageData);
                    }
                    compositeImage(img, rect.data.imageData, rect.x, rect.y);
                    if (debug) {
                        const x_woffset = rect.x - rect.data.fontData.xoffset + (distanceRange >> 1);
                        const y_woffset = rect.y - rect.data.fontData.yoffset + baseline + (distanceRange >> 1);
                        svg += font.charToGlyph(rect.data.fontData.char).getPath(x_woffset, y_woffset, fontSize).toSVG() + "\n";
                    }
                }
                const charData = rect.data.fontData;
                charData.push(rect.x);
                charData.push(rect.y);
                // charData.page = index;
                chars.push(rect.data.fontData);
            });
            const buffer = await encodeTexture(img, imageType);
            let tex = {
                filename: path.join(fontDir, texname),
                texture: buffer,
                extension: imageType
            }
            if (debug) tex.svg = svg;
            return tex;
        });

        const asyncTextures = await Promise.all(textures);

        const kernings = {};
        charset.forEach(first => {
            charset.forEach(second => {
                const amount = font.getKerningValue(font.charToGlyph(first), font.charToGlyph(second));
                const f = first.codePointAt(0);
                const s = second.codePointAt(0);
                const a = amount * (fontSize / font.unitsPerEm);
                if (amount !== 0) {
                    if (kernings[f] === undefined) kernings[f] = {};
                    kernings[f][s] = a;
                }
            });
        });

        const fontData = {
            pages,
            chars,
            kernings,
            size: fontSize,
            // info: {
            // face: fontface,
            // size: fontSize,
            // bold: 0,
            // italic: 0,
            // charset,
            // unicode: 1,
            // stretchH: 100,
            // smooth: 1,
            // aa: 1,
            // padding: fontPadding,
            // spacing: fontSpacing,
            // outline: 0
            // },
            width: packer.bins[0].width,
            height: packer.bins[0].height,
            line_height: (os2.sTypoAscender - os2.sTypoDescender + os2.sTypoLineGap) * (fontSize / font.unitsPerEm),
            // base: baseline,
            // common: {
            //   lineHeight: (os2.sTypoAscender - os2.sTypoDescender + os2.sTypoLineGap) * (fontSize / font.unitsPerEm),
            //   base: baseline,
            //   scaleW: packer.bins[0].width,
            //   scaleH: packer.bins[0].height,
            //   pages: packer.bins.length,
            //   packed: 0,
            //   alphaChnl: 0,
            //   redChnl: 0,
            //   greenChnl: 0,
            //   blueChnl: 0
            // },
            // distanceField: {
            // fieldType: fieldType,
            // distanceRange: distanceRange
            // },

        };
        if (roundDecimal !== null) utils.roundAllValue(fontData, roundDecimal, true);
        let fontFile = {};
        const ext = outputType === "json" ? `.json` : `.fnt`;
        fontFile.filename = path.join(fontDir, fontface + ext);
        fontFile.data = utils.stringify(fontData, outputType);

        // Store pages name and available packer freeRects in settings
        settings.pages = pages;
        settings.packer = {};
        settings.packer.bins = packer.save();
        fontFile.settings = settings;

        console.log("\nGeneration complete!\n");
        callback(null, asyncTextures, fontFile);
    });
}

function generateImage(opt, callback) {
    const { binaryPath, font, char, fontSize, fieldType, distanceRange, roundDecimal, debug, tolerance } = opt;
    const glyph = font.charToGlyph(char);
    const commands = glyph.getPath(0, 0, fontSize).commands;
    let contours = [];
    let currentContour = [];
    const bBox = glyph.getPath(0, 0, fontSize).getBoundingBox();
    commands.forEach(command => {
        if (command.type === 'M') { // new contour
            if (currentContour.length > 0) {
                contours.push(currentContour);
                currentContour = [];
            }
        }
        currentContour.push(command);
    });
    contours.push(currentContour);

    if (tolerance != 0) {
        utils.setTolerance(tolerance, tolerance * 10);
        let numFiltered = utils.filterContours(contours);
        if (numFiltered && debug)
            console.log(`\n${char} removed ${numFiltered} small contour(s)`);
        // let numReversed = utils.alignClockwise(contours, false);
        // if (numReversed && debug)
        //   console.log(`${char} found ${numReversed}/${contours.length} reversed contour(s)`);
    }
    let shapeDesc = utils.stringifyContours(contours);

    if (contours.some(cont => cont.length === 1)) console.log('length is 1, failed to normalize glyph');
    const scale = fontSize / font.unitsPerEm;
    const baseline = font.tables.os2.sTypoAscender * (fontSize / font.unitsPerEm);
    const pad = distanceRange >> 1;
    let width = Math.round(bBox.x2 - bBox.x1) + pad + pad;
    let height = Math.round(bBox.y2 - bBox.y1) + pad + pad;
    let xOffset = Math.round(-bBox.x1) + pad;
    let yOffset = Math.round(-bBox.y1) + pad;
    if (roundDecimal != null) {
        xOffset = utils.roundNumber(xOffset, roundDecimal);
        yOffset = utils.roundNumber(yOffset, roundDecimal);
    }
    let command = `"${binaryPath}" ${fieldType} -format text -stdout -size ${width} ${height} -translate ${xOffset} ${yOffset} -pxrange ${distanceRange} -stdin`;

    let subproc = exec(command, (err, stdout, stderr) => {
        if (err) return callback(err);
        const rawImageData = stdout.match(/([0-9a-fA-F]+)/g).map(str => parseInt(str, 16)); // split on every number, parse from hex
        const pixels = [];
        const channelCount = rawImageData.length / width / height;

        if (!isNaN(channelCount) && channelCount % 1 !== 0) {
            console.error(command);
            console.error(stdout);
            return callback(new RangeError('msdfgen returned an image with an invalid length'));
        }
        if (fieldType === 'msdf') {
            for (let i = 0; i < rawImageData.length; i += channelCount) {
                pixels.push(...rawImageData.slice(i, i + channelCount), 255); // add 255 as alpha every 3 elements
            }
        } else {
            for (let i = 0; i < rawImageData.length; i += channelCount) {
                pixels.push(rawImageData[i], rawImageData[i], rawImageData[i], rawImageData[i]); // make monochrome w/ alpha
            }
        }
        let imageData;
        if (isNaN(channelCount) || !rawImageData.some(x => x !== 0)) { // if character is blank
            if (process.stdout.isTTY) {
                readline.clearLine(process.stdout);
                readline.cursorTo(process.stdout, 0);
            }
            console.log(`Warning: no bitmap for character '${char}' (${char.codePointAt(0)}), adding to font as empty`);
            width = 0;
            height = 0;
        } else {
            imageData = {
                data: new Uint8ClampedArray(pixels),
                width,
                height
            };
        }
        const container = {
            data: {
                imageData,
                fontData: [
                    char.codePointAt(0), // id
                    width,
                    height,
                    Math.round(bBox.x1) - pad, // xoffset
                    Math.round(bBox.y1) + pad + baseline, // yoffset
                    glyph.advanceWidth * scale // xadvance
                ]
            },
            width: width,
            height: height
        };
        callback(null, container);
    });

    subproc.stdin.write(shapeDesc);
    subproc.stdin.write('\n');
    subproc.stdin.destroy();
}

function mapLimit(items, limit, iterator, callback) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let active = 0;
    let completed = 0;
    let done = false;

    if (items.length === 0) return callback(null, results);

    function launch() {
        if (done) return;
        while (active < limit && nextIndex < items.length) {
            const index = nextIndex++;
            active++;
            iterator(items[index], (error, result) => {
                active--;
                if (done) return;
                if (error) {
                    done = true;
                    return callback(error);
                }
                results[index] = result;
                completed++;
                if (completed === items.length) {
                    done = true;
                    return callback(null, results);
                }
                launch();
            });
        }
    }

    launch();
}

function createProgress(total) {
    let value = 0;
    const interactive = Boolean(process.stdout.isTTY);
    return {
        start() {
            if (total > 0 && interactive) process.stdout.write(`Generating 0% (0/${total})`);
        },
        increment() {
            value++;
            if (total === 0 || !interactive) return;
            const percentage = Math.floor((value / total) * 100);
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(`Generating ${percentage}% (${value}/${total})`);
        },
        stop() {
            if (total > 0 && interactive) {
                readline.clearLine(process.stdout, 0);
                readline.cursorTo(process.stdout, 0);
            }
        }
    };
}

class ShelfPacker {
    constructor(width, height, padding, options = {}) {
        this.width = Number(width) || 512;
        this.height = Number(height) || 512;
        this.padding = Number(padding) || 0;
        this.options = options;
        this.bins = [];
    }

    addArray(items) {
        const packed = this.findBestSingleBin(items);
        if (!packed) throw new RangeError('Unable to pack glyphs into a single texture');
        this.bins = [packed];
        this.resizeBins();
    }

    resizeBins() {
        if (!this.options.smart && !this.options.pot && !this.options.square) return;
        this.bins.forEach(bin => {
            let usedWidth = 1;
            let usedHeight = 1;
            bin.rects.forEach(rect => {
                usedWidth = Math.max(usedWidth, rect.x + rect.width + bin.border);
                usedHeight = Math.max(usedHeight, rect.y + rect.height + bin.border);
            });
            if (this.options.smart) {
                bin.width = Math.min(bin.width, usedWidth);
                bin.height = Math.min(bin.height, usedHeight);
            }
            if (this.options.pot) {
                bin.width = nextPowerOfTwo(bin.width);
                bin.height = nextPowerOfTwo(bin.height);
            }
            if (this.options.square) {
                const size = Math.max(bin.width, bin.height);
                bin.width = size;
                bin.height = size;
            }
        });
    }

    findBestSingleBin(items) {
        const sorted = items.slice().sort((a, b) => {
            const areaDiff = (b.width * b.height) - (a.width * a.height);
            if (areaDiff !== 0) return areaDiff;
            const heightDiff = b.height - a.height;
            if (heightDiff !== 0) return heightDiff;
            return b.width - a.width;
        });
        const border = this.options.border || 0;
        const visibleItems = sorted.filter(item => item.width > 0 && item.height > 0);

        if (visibleItems.length === 0) {
            const bin = new ShelfBin(Math.max(1, border * 2 + 1), Math.max(1, border * 2 + 1), this.padding, border);
            sorted.forEach(item => bin.add(item));
            return bin;
        }

        const maxItemWidth = visibleItems.reduce((max, item) => Math.max(max, item.width), 0) + border * 2;
        const maxItemHeight = visibleItems.reduce((max, item) => Math.max(max, item.height), 0) + border * 2;
        const paddedArea = visibleItems.reduce((sum, item) => {
            return sum + (item.width + this.padding) * (item.height + this.padding);
        }, border * border * 4);
        const targetAspect = Math.max(0.8, Math.min(1.25, this.width / this.height || 1));
        const targetWidth = Math.max(maxItemWidth, Math.ceil(Math.sqrt(paddedArea * targetAspect)));
        const minWidth = Math.max(maxItemWidth, Math.floor(targetWidth * 0.7));
        const maxWidth = Math.max(minWidth, Math.ceil(targetWidth * 1.45), this.width);
        const step = Math.max(1, Math.ceil(targetWidth / 96));
        const candidates = new Set([maxItemWidth, this.width, targetWidth, minWidth, maxWidth]);

        for (let width = minWidth; width <= maxWidth; width += step) {
            candidates.add(width);
        }

        let best = null;
        Array.from(candidates)
            .map(width => Math.max(maxItemWidth, Math.ceil(width)))
            .sort((a, b) => a - b)
            .forEach(width => {
                const bin = this.packToWidth(sorted, width);
                if (!bin || bin.height < maxItemHeight) return;
                const score = scoreBin(bin);
                const bestScore = best ? scoreBin(best) : Infinity;
                if (score < bestScore) {
                    best = bin;
                }
            });

        return best;
    }

    packToWidth(items, width) {
        const border = this.options.border || 0;
        const bin = new ShelfBin(width, Number.MAX_SAFE_INTEGER, this.padding, border);
        for (const item of items) {
            if (!bin.add(item)) return null;
        }
        let usedWidth = 1;
        let usedHeight = 1;
        bin.rects.forEach(rect => {
            usedWidth = Math.max(usedWidth, rect.x + rect.width + border);
            usedHeight = Math.max(usedHeight, rect.y + rect.height + border);
        });
        bin.width = this.options.smart ? usedWidth : Math.max(this.width, usedWidth);
        bin.height = this.options.smart ? usedHeight : Math.max(this.height, usedHeight);
        if (this.options.pot) {
            bin.width = nextPowerOfTwo(bin.width);
            bin.height = nextPowerOfTwo(bin.height);
        }
        if (this.options.square) {
            const size = Math.max(bin.width, bin.height);
            bin.width = size;
            bin.height = size;
        }
        return bin;
    }

    save() {
        return this.bins.map(bin => ({
            width: bin.width,
            height: bin.height,
            rects: bin.rects.map(rect => ({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            }))
        }));
    }
}

function scoreBin(bin) {
    const area = bin.width * bin.height;
    const aspect = Math.max(bin.width / bin.height, bin.height / bin.width);
    return area * (1 + Math.pow(Math.log(aspect), 2) * 0.9);
}

class ShelfBin {
    constructor(width, height, padding, border) {
        this.width = width;
        this.height = height;
        this.padding = padding;
        this.border = border;
        this.x = border;
        this.y = border;
        this.rowHeight = 0;
        this.rects = [];
    }

    canFit(item) {
        if (item.width === 0 || item.height === 0) return true;
        if (item.width + this.border * 2 > this.width || item.height + this.border * 2 > this.height) return false;
        return this.y + this.rowHeight + this.padding + item.height + this.border <= this.height
            || this.y + item.height + this.border <= this.height;
    }

    add(item) {
        const width = item.width || 0;
        const height = item.height || 0;
        if (width === 0 || height === 0) {
            this.rects.push({ x: this.border, y: this.border, width, height, data: item.data, rot: false });
            return true;
        }
        if (width + this.border * 2 > this.width || height + this.border * 2 > this.height) return false;
        if (this.x + width + this.border > this.width) {
            this.x = this.border;
            this.y += this.rowHeight + this.padding;
            this.rowHeight = 0;
        }
        if (this.y + height + this.border > this.height) return false;

        this.rects.push({ x: this.x, y: this.y, width, height, data: item.data, rot: false });
        this.x += width + this.padding;
        this.rowHeight = Math.max(this.rowHeight, height);
        return true;
    }
}

function nextPowerOfTwo(value) {
    let result = 1;
    while (result < value) result *= 2;
    return result;
}

function createImage(width, height, color) {
    const data = new Uint8ClampedArray(width * height * 4);
    const rgba = [
        (color >>> 24) & 255,
        (color >>> 16) & 255,
        (color >>> 8) & 255,
        color & 255
    ];
    for (let i = 0; i < data.length; i += 4) {
        data[i] = rgba[0];
        data[i + 1] = rgba[1];
        data[i + 2] = rgba[2];
        data[i + 3] = rgba[3];
    }
    return { width, height, data };
}

function compositeImage(target, source, x, y) {
    for (let row = 0; row < source.height; row++) {
        const targetY = y + row;
        if (targetY < 0 || targetY >= target.height) continue;
        for (let col = 0; col < source.width; col++) {
            const targetX = x + col;
            if (targetX < 0 || targetX >= target.width) continue;
            const sourceIndex = (row * source.width + col) * 4;
            const targetIndex = (targetY * target.width + targetX) * 4;
            target.data[targetIndex] = source.data[sourceIndex];
            target.data[targetIndex + 1] = source.data[sourceIndex + 1];
            target.data[targetIndex + 2] = source.data[sourceIndex + 2];
            target.data[targetIndex + 3] = source.data[sourceIndex + 3];
        }
    }
}

function rotateImage90(image) {
    const rotated = createImage(image.height, image.width, 0x00000000);
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const sourceIndex = (y * image.width + x) * 4;
            const targetX = image.height - y - 1;
            const targetY = x;
            const targetIndex = (targetY * rotated.width + targetX) * 4;
            rotated.data[targetIndex] = image.data[sourceIndex];
            rotated.data[targetIndex + 1] = image.data[sourceIndex + 1];
            rotated.data[targetIndex + 2] = image.data[sourceIndex + 2];
            rotated.data[targetIndex + 3] = image.data[sourceIndex + 3];
        }
    }
    return rotated;
}

async function encodeTexture(image, imageType) {
    if (imageType === 'png') return encodePng(image);
    return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
        raw: {
            width: image.width,
            height: image.height,
            channels: 4
        }
    }).webp({
        lossless: true,
        effort: 6
    }).toBuffer();
}

function encodePng(image) {
    const stride = image.width * 4;
    const raw = Buffer.alloc((stride + 1) * image.height);
    for (let y = 0; y < image.height; y++) {
        const rawOffset = y * (stride + 1);
        raw[rawOffset] = 0;
        Buffer.from(image.data.buffer, image.data.byteOffset + y * stride, stride).copy(raw, rawOffset + 1);
    }

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', createIhdr(image.width, image.height)),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function createIhdr(width, height) {
    const data = Buffer.alloc(13);
    data.writeUInt32BE(width, 0);
    data.writeUInt32BE(height, 4);
    data[8] = 8;
    data[9] = 6;
    data[10] = 0;
    data[11] = 0;
    data[12] = 0;
    return data;
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) {
        crc = crcTable[(crc ^ buffer[i]) & 255] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
