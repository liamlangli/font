#!/usr/bin/env node

const pkg = require('./package.json');
const generateBMFont = require('./index');
const fs = require('fs');
const path = require('path');
const utils = require('./lib/utils');

const charsetPresets = {
    zh_cn: [
        path.join(__dirname, 'charset', 'en_common.txt'),
        path.join(__dirname, 'charset', 'zh_cn_3500.txt')
    ]
};

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
    printHelp();
    process.exit(0);
}
if (parsed.version) {
    console.log('ufont v' + pkg.version);
    process.exit(0);
}

//
// Initialize options 
//
let opt = parsed.options;
utils.roundAllValue(opt); // Parse all number from string
let fontFile = parsed.fontFile;
if (!fontFile) {
    console.error('Must specify font-file, use: \'ufont -h\' for more infomation');
    process.exit(1);
}
fontFile = fileExistValidate(fontFile);
const fontface = path.basename(fontFile, path.extname(fontFile));
const fontDir = path.dirname(fontFile);

//
// Set default value
//
opt.fontFile = fontFile;
if (typeof opt.reuse === 'boolean') {
    opt.filename = utils.valueQueue([opt.filename, path.join(fontDir, fontface)]);
    opt.vector = utils.valueQueue([opt.vector, false]);
    opt.reuse = utils.valueQueue([opt.reuse, false]);
    opt.smartSize = utils.valueQueue([opt.smartSize, true]);
    opt.pot = utils.valueQueue([opt.pot, false]);
    opt.square = utils.valueQueue([opt.square, false]);
    opt.rot = utils.valueQueue([opt.rot, false]);
    opt.rtl = utils.valueQueue([opt.rtl, false]);
} else {
    opt.filename = utils.valueQueue([opt.filename, path.join("./", fontface)]);
}

//
// Display options 
//
const keys = Object.keys(opt)
const padding = longestLength(keys) + 2;
console.log("\nUsing following settings");
console.log("========================================");
keys.forEach(key => {
    if (typeof opt.reuse === 'string' && typeof opt[key] === 'undefined') {
        console.log(pad(key, padding) + ": Defined in [" + opt.reuse + "]");
    } else if (key === 'charsetFile' && typeof opt[key] === 'undefined' && typeof opt.charset === 'undefined') {
        console.log(pad(key, padding) + ": Unspecified, fallback to ASC-II");
    } else console.log(pad(key, padding) + ": " + opt[key]);
});
console.log("========================================");

//
// Validate
//
if (typeof opt.fontFile === 'undefined') {
    console.error('No font file specified, aborting.... use -h for help');
    process.exit(1);
}
if (typeof opt.reuse !== 'boolean') opt.reuse = fileValidate(opt.reuse);

loadCharset(opt, (error, data) => {
    if (error) {
        console.warn(error.message);
        delete opt.charset;
    }
    if (data) opt.charset = data;

    generateBMFont(opt.fontFile, opt, (error, textures, font) => {
        if (error) throw error;
        textures.forEach((texture, index) => {
            if (opt.vector) {
                const content = `<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${opt.textureWidth}" height="${opt.textureHeight}">
${texture.svg}
</svg>`;
                fs.writeFile(`${texture.filename}.svg`, content, (err) => {
                    if (err) throw err;
                    console.log('wrote svg[', index, ']         : ', `${texture.filename}.svg`);
                });
            }
            const extension = texture.extension || opt.imageType || 'webp';
            fs.writeFile(`${texture.filename}.${extension}`, texture.texture, (err) => {
                if (err) throw err;
                console.log('wrote spritesheet[', index, '] : ', `${texture.filename}.${extension}`);
            });
        });
        fs.writeFile(font.filename, font.data, (err) => {
            if (err) throw err;
            console.log('wrote font file        : ', font.filename);
        });
        if (opt.reuse !== false) {
            let cfgFileName = typeof opt.reuse === 'boolean' ? `${textures[0].filename}.cfg` : opt.reuse;
            fs.writeFile(cfgFileName, JSON.stringify(font.settings, null, '\t'), (err) => {
                if (err) throw err;
                console.log('wrote cfg file         : ', cfgFileName);
            });
        }
    });
});

/**
 * Pad `str` to `width`.
 *
 * @param {String} str
 * @param {Number} width
 * @return {String}
 * @api private
 */
function pad(str, width) {
    var len = Math.max(0, width - str.length);
    return str + Array(len + 1).join(' ');
}

/**
 * Return the largest length of string array.
 *
 * @param {Array.<String>} arr
 * @return {Number}
 * @api private
 */

function longestLength(arr) {
    return arr.reduce((max, element) => {
        return Math.max(max, element.length);
    }, 0);
};

function parseArgs(args) {
    const options = {
        outputType: 'json',
        imageType: 'webp',
        fontSize: 42,
        textureSize: [2048, 2048],
        texturePadding: 1,
        border: 0,
        distanceRange: 4,
        fieldType: 'msdf',
        roundDecimal: 0,
        vector: false,
        reuse: false,
        smartSize: true,
        pot: false,
        square: false,
        rot: false,
        rtl: false
    };
    let fontFile;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '-h':
            case '--help':
                return { help: true, options };
            case '-V':
            case '--version':
                return { version: true, options };
            case '-f':
            case '--output-type':
                options.outputType = readOptionValue(args, ++i, arg);
                break;
            case '--image-type':
                options.imageType = readOptionValue(args, ++i, arg);
                break;
            case '-o':
            case '--filename':
                options.filename = readOptionValue(args, ++i, arg);
                break;
            case '-s':
            case '--font-size':
                options.fontSize = readOptionValue(args, ++i, arg);
                break;
            case '-c':
            case '--charset':
                options.charset = readOptionValue(args, ++i, arg);
                break;
            case '-i':
            case '--charset-file':
                options.charsetFile = fileExistValidate(readOptionValue(args, ++i, arg));
                break;
            case '-m':
            case '--texture-size':
                options.textureSize = readOptionValue(args, ++i, arg).split(',');
                break;
            case '-p':
            case '--texture-padding':
                options.texturePadding = readOptionValue(args, ++i, arg);
                break;
            case '-b':
            case '--border':
                options.border = readOptionValue(args, ++i, arg);
                break;
            case '-r':
            case '--distance-range':
                options.distanceRange = readOptionValue(args, ++i, arg);
                break;
            case '-t':
            case '--field-type':
                options.fieldType = readOptionValue(args, ++i, arg);
                break;
            case '-d':
            case '--round-decimal':
                options.roundDecimal = readOptionValue(args, ++i, arg);
                break;
            case '-v':
            case '--vector':
                options.vector = true;
                break;
            case '-u':
            case '--reuse':
                if (args[i + 1] && !args[i + 1].startsWith('-')) options.reuse = args[++i];
                else options.reuse = true;
                break;
            case '--smart-size':
                options.smartSize = true;
                break;
            case '--pot':
                options.pot = true;
                break;
            case '--square':
                options.square = true;
                break;
            case '--rot':
                options.rot = true;
                break;
            case '--rtl':
                options.rtl = true;
                break;
            default:
                if (arg.startsWith('-')) {
                    console.error(`Unknown option: ${arg}`);
                    process.exit(1);
                }
                fontFile = arg;
        }
    }

    return { options, fontFile };
}

function readOptionValue(args, index, optionName) {
    const value = args[index];
    if (!value || value.startsWith('-')) {
        console.error(`Missing value for ${optionName}`);
        process.exit(1);
    }
    return value;
}

function printHelp() {
    console.log(`ufont v${pkg.version}

Usage: ufont [options] <font-file>

Creates a BMFont compatible bitmap font of signed distance fields from a font file

Options:
  -f, --output-type <format>       font file format: xml(default) | json | txt
      --image-type <format>        texture image format: webp(default) | png
  -o, --filename <atlas_path>      filename of font textures
  -s, --font-size <fontSize>       font size for generated textures
  -c, --charset <preset>           built-in charset preset: zh_cn
  -i, --charset-file <charset>     user-specified charactors from text-file
  -m, --texture-size <w,h>         preferred atlas shape for single-image packing
  -p, --texture-padding <n>        padding between glyphs
  -b, --border <n>                 space between glyphs textures & edge
  -r, --distance-range <n>         distance range for SDF
  -t, --field-type <type>          msdf(default) | sdf | psdf
  -d, --round-decimal <digit>      rounded digits of the output font file
  -v, --vector                     generate svg vector file for debuging
  -u, --reuse [file.cfg]           save/create config file for reusing settings
      --smart-size                 auto-size the single atlas for better pixel usage
      --pot                        force power-of-two size after packing
      --square                     atlas size shall be square
      --rot                        allow 90-degree rotation while packing
      --rtl                        use RTL(Arabic/Persian) charactors fix
  -h, --help                       display help
  -V, --version                    display version`);
}

function fileExistValidate(filePath) {
    try {
        if (fs.statSync(filePath).isFile()) return path.normalize(filePath);
        else {
            console.error('File: ', filePath, ' not found! Aborting...');
            process.exit(1);
        }
    } catch (err) {
        console.error('File: ', filePath, ' not valid! Aborting...');
        process.exit(1);
    }
}

function loadCharset(opt, callback) {
    if (opt.charsetFile) {
        return fs.readFile(opt.charsetFile, 'utf8', (error, data) => {
            if (error) return callback(new Error('No valid charset file loaded, fallback to ASC-II'));
            callback(null, normalizeCharsetContent(data));
        });
    }

    if (!opt.charset) {
        return callback(null);
    }

    const presetFiles = charsetPresets[opt.charset];
    if (!presetFiles) {
        const available = Object.keys(charsetPresets).join(', ');
        console.error(`Unknown charset preset: ${opt.charset}. Available presets: ${available}`);
        process.exit(1);
    }

    fs.readFile(presetFiles[0], 'utf8', (firstError, firstData) => {
        if (firstError) return callback(new Error(`No valid charset preset loaded: ${opt.charset}, fallback to ASC-II`));
        fs.readFile(presetFiles[1], 'utf8', (secondError, secondData) => {
            if (secondError) return callback(new Error(`No valid charset preset loaded: ${opt.charset}, fallback to ASC-II`));
            callback(null, normalizeCharsetContent(firstData) + normalizeCharsetContent(secondData));
        });
    });
}

function normalizeCharsetContent(data) {
    return data.replace(/^\uFEFF/, '');
}

function fileValidate(filePath) {
    if (typeof filePath !== 'string' || filePath.includes('\0')) {
        console.error('File: ', filePath, ' not valid! Aborting...');
        process.exit(1);
    } else return path.normalize(filePath);
}
