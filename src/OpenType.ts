const log = console.log;

function assert(condition: boolean, message = "Assertion failed.") {
    if (!condition) {
        console.log(new Error(message))
        throw new Error(message);
    }
}

// Represents a CFF instruction. They can have a opcode, plus
// any number of floating point arguments. Some opcodes begin with 12. In this case
// they are two bytes, with the high byte 0x0c.
class OpCode {
    constructor(public code: number, public operands: number[]) { }
    toString() {
        let str: string;
        if (this.code > 255) {
            str = `code=12 ${this.code & 0xff}`
        } else {
            str = `${this.code}`
        }
        return str + " " + JSON.stringify(this.operands);
    }
}

// This slice lets us seek around a file and read various parts of it.
class Slice {
    private pos = 0;
    constructor(private arr: Uint8Array, private start = 0, readonly length = arr.length - start) { }
    getUint(len: number) {
        let result = 0;
        while (len--) {
            result = result * 256 + this.arr[this.pos++ + this.start];
        }
        return result;
    }

    getInt16() {
        let result = this.getUint(2);
        if (result & 0x8000) {
            result -= (1 << 16);
        }
        return result;
    }

    getString(length: number, width: number = 1) {
        var result = "";
        for (var i = 0; i < length; i += width) {
            result += String.fromCharCode(this.getUint(width));
        }
        return result;
    }

    get2Dot14() {
        return this.getInt16() / (1 << 14);
    }

    seek(pos: number) {
        if (pos > this.length) {
            throw new Error("Seek to invalid location");
        }
        let ret = this.pos;
        this.pos = pos;
        return ret;
    }

    tell() {
        return this.pos;
    }

    slice(start: number, length = this.length - start) {
        return new Slice(this.arr, start + this.start, length);
    }

    indexSkip(start: number = this.tell()) {
        this.seek(start);
        const count = this.getUint(2);
        if (count > 0) {
            const offSize = this.getUint(1);
            this.seek(start + 3 + offSize * count);
            const elemOffset = this.getUint(offSize);
            this.seek(start + 3 + (count + 1) * offSize - 1 + elemOffset);
        }
        return start;
    }

    // CFF
    getIndexCount(start: number) {
        this.seek(start);
        let count = this.getUint(2);
        let offsetSize = this.getUint(1);
        if (offsetSize > 4) {
            throw new Error("Error: This is not an index; offsetSize=" + offsetSize);
        }
        return count;
    }

    /** Seek to the CFF index given at start, and then return a slice of that entry */
    indexSeek(start: number, n: number): Slice {
        this.seek(start);
        const count = this.getUint(2);
        if (n >= count) {
            throw new Error("Tried to read past end of index");
        }

        const offSize = this.getUint(1);
        this.seek(start + 3 + offSize * n);
        let elemOffset = this.getUint(offSize);
        //log("count=%s offSize=%s elemOffset=%s", count, offSize, elemOffset);
        let nextOffset = this.getUint(offSize);
        let offset = start + 3 + (count + 1) * offSize - 1 + elemOffset;
        return this.slice(offset, nextOffset - elemOffset);
    }

    eof() {
        return this.pos >= this.length;
    }

    getInstruction(type2 = false, stack: number[] = []): OpCode {
        let ret = new OpCode(0, stack);
        for (; ;) {
            if (this.eof()) {
                throw new Error("Unexpected end of charstring");
            }

            const b0 = this.getUint(1);
            //log("Read b0=%s", b0);

            if (b0 === 12) {
                ret.code = 0x0c00 | this.getUint(1);
                return ret;
            } else if (b0 < 28 || type2 && b0 >= 29 && b0 <= 31) {
                ret.code = b0;
                return ret;
            } else if (b0 === 30) {
                // real
                let str = "";
                outer:
                for (; ;) {
                    let b = this.getUint(1);
                    for (let i = 4; i >= 0; i -= 4) {
                        let code = (b >> i) & 0x0f;
                        switch (code) {
                            case 0xa: str += "."; break;
                            case 0xb: str += "E"; break;
                            case 0xc: str += "E-"; break;
                            case 0xe: str += "-"; break;
                            case 0xf: break outer;
                            case 0xe: /* reserved */ break;
                            default:
                                str += code.toString();
                        }
                    }
                }
                ret.operands.push(parseFloat(str));
            } else if (b0 === 29) {
                const b1 = this.getUint(1);
                const b2 = this.getUint(1);
                const b3 = this.getUint(1);
                const b4 = this.getUint(1);
                ret.operands.push((b1 << 24) | (b2 << 16) | (b3 << 8) | b4);
            } else if (b0 === 28) {
                const b1 = this.getUint(1);
                const b2 = this.getUint(1);
                ret.operands.push((b1 << 8) | b2);
            } else if (type2 && b0 === 255) {
                ret.operands.push(this.getUint(4) / 0x10000);
            } else if (b0 >= 251) {
                const b1 = this.getUint(1);
                ret.operands.push(-(b0 - 251) * 256 - b1 - 108);
            } else if (b0 >= 247) {
                const b1 = this.getUint(1);
                ret.operands.push((b0 - 247) * 256 + b1 + 108);
            } else {
                ret.operands.push(b0 - 139);
            }
        }
    }

}

// ------------------------------------------------------------------------------
// This is a tokenizer, part of the byte parsing. I wanted to have something
// where I can just write out the font structures and have code automatically
// read them in. This is the tokenizer for the mini-language I created for this 
// purpose.
// 
// The decode function takes the structure description, and a Slice, and
// parses the data into a JSON structure.
class Tokens {
    private tokens: string[] = []
    n = 0
    constructor(input: string) {
        const regex = /([:\[\]\(\)\-\.{}]|\d+)|\s+/;
        for (let item of input.split(regex)) {
            if (item && item.length) {
                this.tokens.push(item);
            }
        }
    }

    next() {
        return this.tokens[this.n++];
    }

    peek() {
        return this.tokens[this.n];
    }

    match(tok: string) {
        if (this.tokens[this.n] === tok) {
            this.n += 1;
            return true;
        }
        return false;
    }

    value(context: any) {
        let value = this.next();
        let num = parseFloat(value);
        if (isNaN(num)) {
            return context[value];
        }
        return num;
    }

    fail(oldPos: number) {
        this.n = oldPos;
        return false;
    }
}

function parseData(tokens: Tokens, input: Slice, obj: any, skipping: boolean) {
    /** data = '{' namedValue* '}' | value */
    if (tokens.match("{")) {
        obj = {};
        while (parseNamedValue(tokens, input, obj, skipping)) { }
        tokens.match("}");
        return obj;
    }
    return parseValue(tokens, input, obj, skipping);
}

function parseNamedValue(tokens: Tokens, input: Slice, obj: any, skipping: boolean) {
    // namedValue = 'push' expr namedValue* pop | name ':' value 
    const at = tokens.n;
    if (tokens.match("push")) {
        const offset = parseExpr(tokens, obj);
        input = input.slice(offset);
        while (parseNamedValue(tokens, input, obj, skipping)) { }
        if (!tokens.match("pop")) {
            return false
        }
        return true;
    }

    let name = tokens.next();
    if (tokens.match(":")) {
        const value = parseValue(tokens, input, obj, skipping);
        if (name !== '_') {
            obj[name] = value;
        }
        return true;
    }
    return tokens.fail(at);
}

function parseValue(tokens: Tokens, input: Slice, obj: any, skipping: boolean) {
    const at = tokens.n;
    // value = ("[" expr "]")? type
    if (tokens.match("[")) {
        let count = parseExpr(tokens, obj);
        let tag = "";
        let ret: any = [];
        if (tokens.match('.')) {
            tag = tokens.next();
            ret = {};
        }
        if (!tokens.match("]")) {
            return tokens.fail(at);
        }
        const start = tokens.n;
        for (let i = 0; i < count; i++) {
            tokens.n = start;
            let result = parseData(tokens, input, obj, skipping);
            if (tag === "") {
                ret.push(result);
            } else {
                ret[result[tag]] = result;
            }
        }
        if (count === 0) { // skip over description
            parseData(tokens, input, obj, true);
        }
        return ret;
    }

    if (tokens.match("(")) {
        let num = parseExpr(tokens, obj);
        tokens.match(")");
        return num;
    } else if (tokens.match("uint")) {
        let num = tokens.value(obj) / 8;
        return skipping ? 0 : input.getUint(num);
    } else if (tokens.match("int")) {
        tokens.next(); // skip '16'
        return skipping ? 0 : input.getInt16();
    } else if (tokens.match("offset")) {
        return input.tell();
    } else if (tokens.match("date")) {
        const macTime = input.getUint(4) * 0x100000000 + input.getUint(4);
        const utcTime = macTime * 1000 + Date.UTC(1904, 1, 1);
        return new Date(utcTime);
    } else if (tokens.match("fixed")) {
        return skipping ? 0 : input.getUint(4) / (1 << 16);
    } else if (tokens.match("string")) {
        if (!tokens.match("(")) {
            return tokens.fail(at);
        }
        const length = parseExpr(tokens, obj);
        if (!tokens.match(")")) {
            return tokens.fail(at);
        }
        return skipping ? 0 : input.getString(length);
    }
    return tokens.fail(at);
}

function parseExpr(tokens: Tokens, obj: any) {
    // expr = num - num | num
    let value = tokens.value(obj);
    if (tokens.match("-")) {
        value -= tokens.value(obj);
    } else if (tokens.match(":")) { // item:bit#
        const bit = tokens.value(obj);
        value = (value >> bit) & 1;
    }
    return value;
}

// This is the magic function that takes a structure description and 
// parses it into JSON.
function decode(input: Slice, spec: string): any {
    return parseData(new Tokens(spec), input, null, false);
}

const TTC_HEADER = `{
    ttcTag:string(4)
    majorVersion:uint16
    minorVersion:uint16
    numFonts:uint32
    offsetTable:[numFonts] uint32
}`

const OFFSET_TABLES = `{  
    scalarType:uint32
    numTables:uint16
    searchRange:uint16
    entrySelector:uint16
    rangeShift:uint16
    tables:[numTables.tag] {
        tag:string(4)
        checksum:uint32
        offset:uint32
        length:uint32
    }
}`

const HEAD_TABLE = `{
    version:fixed
    fontRevision:fixed
    checksumAdjustment:uint32
    magicNumber:uint32
    flags:uint16
    unitsPerEm:uint16
    created:date
    modified:date
    xMin:int16
    yMmin:int16
    xMax:int16
    yMax:int16
    macStyle:uint16
    lowestRectPPEM:uint16
    fontDirectionHint:uint16
    indexToLocFormat:uint16
    glyphDataFormat:uint16

    bold:(macStyle:0)
    italic:(macStyle:1)
}`

const CMAP_TABLE = `{
    offset:offset
    version:uint16
    numberSubtables:uint16
    subTables:[numberSubtables] {
        platformID:uint16
        platformSpecificID:uint16
        offset:uint32
    }
}`

const NAME_TABLE = `{
    offset:offset
    format:uint16
    count:uint16
    stringOffset:uint16
    names:[count] {
        platformID:uint16
        platformSpecificID:uint16
        languageID:uint16
        nameID:uint16
        length:uint16
        offset:uint16
    }
}`

const HHEA_TABLE = `{
    version:fixed
    ascent:int16
    descent:int16
    lineGap:int16
    advanceWidthMax:uint16
    minLeftSideBearing:int16
    minRightSideBearing:int16
    xMaxExtent:int16
    caretSlopeRise:int16
    caretSlopeRun:uint16
    caretOffset:int16
    reserved:uint64
    metricDataFormat:int16
    numOfLongHorMetrics:uint16
}`

const OS2_TABLE = `{
    version:uint16
    xAvgCharWidth:int16
    usWeightClass:uint16
    usWidthClass:uint16
}`

const KERN_TABLE = `{
    version:uint16
    nTables:uint16
    tables:[nTables] {
        version:uint16
        length:uint16
        coverage:uint16
        offset:offset
        _:[length-6] uint8
    }
}`

const MAXP_TABLE = `{
    version:fixed
    numGlyphs:uint16
}`

const CFF_TABLE = `{
    offset:offset
    major:uint8
    minor:uint8
}`

// A CMAP is any class that maps a unicode codepoint to a glyph index.
interface CMap {
    map(charCode: number): number; // or -1
}

interface Point {
    x: number;
    y: number;
    onCurve: boolean;
}

interface Glyph {
    contourEnds: number[];
    numberOfContours: number;
    points: Point[];
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
}

// In OpenType, a font file can contain many different fonts. Opening with the
// Font Collection will let you access them.
export class FontCollection {
    private fonts: OTFFont[] = []

    async add(url: string) {
        let response = await fetch(url);
        let buffer = await response.arrayBuffer();
        return this.openSync(new Uint8Array(buffer));
    }

    removeAll() {
        this.fonts.length = 0;
    }

    get(name: string): OTFFont | null {
        for (let font of this.fonts) {
            if (font.fullName === name || font.fontFamily === name) {
                return font;
            }
        }
        return null;
    }

    openSync(data: Uint8Array) {
        const f = new Slice(data);
        const magic = f.getUint(4);
        f.seek(0);
        let fonts: OTFFont[]
        if (magic === 0x74746366) { // ttcf
            // it's a font collection
            fonts = this.addOTCFile(f);
        } else { // it's a font file.
            fonts = [new OTFFont(f)];
        }

        outer:
        for (let font of fonts) {
            for (let have of this.fonts) {
                if (have.fullName === font.fullName) {
                    log("Not adding %s; already have it.");
                    continue outer;
                }
            }
            log("Opened font: %s weight=%s italic=%s", font.fullName, font.weight, font.italic);
            console.log(font);
            this.fonts.push(font);
        }

        return fonts;
    }

    private addOTCFile(f: Slice) {
        const header = decode(f, TTC_HEADER);
        log(JSON.stringify(header, null, 2));
        log("Collection contains %s fonts", header["numFonts"]);
        const ret: OTFFont[] = [];
        for (let offset of header["offsetTable"]) {
            ret.push(new OTFFont(f, offset))
        }
        return ret;
    }
}

export class OTFFont {
    private offsetTables: any;
    private tables: { [name: string]: any } = {}
    fontFamily = "";
    fontSubFamily = "";
    fullName = "";
    postscriptName = "";
    weight = 0;
    italic = false;
    bold = false;
    private cmaps: CMap[] = []
    private cff: CFFString | null = null;
    private kerners: KernAdjuster[] = [];
    constructor(private f: Slice, offset = 0) {
        f.seek(offset);
        this.offsetTables = decode(f, OFFSET_TABLES);
        log(JSON.stringify(this.offsetTables, null, 2));
        for (let name in this.offsetTables["tables"]) {
            log("Table: %s", name);
        }
        //console.log("offset", JSON.stringify(this.offsetTables, null, 2));
        this.decodeTable("head", HEAD_TABLE);
        this.decodeTable("name", NAME_TABLE);
        this.decodeTable("cmap", CMAP_TABLE);
        this.decodeTable("hhea", HHEA_TABLE);
        this.decodeTable("kern", KERN_TABLE);
        this.decodeTable("maxp", MAXP_TABLE);
        this.decodeTable("OS/2", OS2_TABLE);
        this.decodeTable("CFF ", CFF_TABLE);

        this.parseNameTable(f, this.tables["name"]);
        this.parseCmap(f, this.tables["cmap"]);
        this.parseGPOS(f);
        this.parseKern(f, this.tables["kern"]);
        this.italic = !!this.tables["head"]["italic"];
        this.bold = !!this.tables["head"]["bold"];
        this.weight = this.tables["OS/2"]["usWeightClass"];

        if ("CFF " in this.tables) {
            this.cff = new CFFString(f.slice(this.tables["CFF "]["offset"]));
        }

    }

    private decodeTable(name: string, spec: string) {
        if (name in this.offsetTables["tables"]) {
            log("Decoding %s", name);
            let offset = this.offsetTables["tables"][name]["offset"];
            this.f.seek(offset);
            this.tables[name] = decode(this.f, spec);
            log(`${name} table:`, JSON.stringify(this.tables[name], null, 2));
        }
    }

    private parseNameTable(f: Slice, nameTable: any) {
        for (let item of nameTable["names"]) {
            let name: string
            f.seek(nameTable["offset"] + nameTable["stringOffset"] + item["offset"]);

            if (item["platformID"] === 0 || item["platformID"] === 3) {
                name = f.getString(item["length"], 2); // UCS-2
            } else {
                name = f.getString(item["length"]); // ASCII
            }

            switch (item["nameID"]) {
                case 1: this.fontFamily = name; break;
                case 2: this.fontSubFamily = name; break;
                case 4: this.fullName = name; break;
                case 6: this.postscriptName = name; break;
            }
        }
    }

    private parseCmap(f: Slice, cmapTable: any) {
        for (let cmap of cmapTable["subTables"]) {
            let platformID = cmap["platformID"];
            let platformSpecificID = cmap["platformSpecificID"];
            let offset = cmapTable["offset"] + cmap["offset"];
            f.seek(offset);
            const format = f.getUint(2);
            const length = f.getUint(2);
            log(`CMAP platform ${platformID} ${platformSpecificID} format ${format} length ${length} at ${offset}`)
            switch (format) {
                case 0:
                    this.cmaps.push(new CMap0(f.slice(offset, length)));
                    break;
                case 4:
                    this.cmaps.push(new CMap4(f.slice(offset, length)));
                    break;
            }
        }
    }

    private parseGPOS(f: Slice) {
        let table = this.offsetTables["tables"]["GPOS"];
        if (table) {
            this.kerners.push(new GPOS(f.slice(table["offset"], table["length"])));
        }
    }

    private parseKern(f: Slice, kernTable: any) {
        if (!kernTable) return;
        for (let table of kernTable["tables"]) {
            if ((table["coverage"] >> 8) === 0) {
                log("Format 0 kern table detected");
                this.kerners.push(new Kern0(f.slice(table["offset"], table["length"])))
            }
        }
    }

    getGlyphCount() {
        return this.tables["maxp"]["numGlyphs"];
    }

    // drawSingleGlyph(ctx: ICanvasContext, glyphIndex: number,
    //     x: number, y: number, size: number) {
    //     ctx.save();
    //     ctx.translate(x, y);
    //     this.transform(ctx, size);
    //     this.drawGlyph(ctx, glyphIndex, 0, 0);
    //     ctx.restore();
    // }

    // transform(ctx: ICanvasContext, size: number) {
    //     let scale = this.getScale(size);
    //     ctx.scale(scale, -scale);
    // }

    // private drawGlyph(ctx: ICanvasContext, index: number, x: number, y: number) {
    //     if (this.cff) {
    //         this.cff.drawGlyph(ctx, index, x, y);
    //         return;
    //     }
    //     var glyph = this.readGlyph(index);
    //     //log("Draw GLyph index %s", index);

    //     if (glyph === null) {
    //         return false;
    //     }

    //     var s = 0,
    //         p = 0,
    //         c = 0,
    //         contourStart = 0,
    //         prev;

    //     for (; p < glyph.points.length; p++) {
    //         var point = glyph.points[p];
    //         if (s === 0) {
    //             ctx.moveTo(point.x + x, point.y + y);
    //             s = 1;
    //         } else if (s === 1) {
    //             if (point.onCurve) {
    //                 ctx.lineTo(point.x + x, point.y + y);
    //             } else {
    //                 s = 2;
    //             }
    //         } else {
    //             prev = glyph.points[p - 1];
    //             if (point.onCurve) {
    //                 ctx.quadraticCurveTo(prev.x + x, prev.y + y,
    //                     point.x + x, point.y + y);
    //                 s = 1;
    //             } else {
    //                 ctx.quadraticCurveTo(prev.x + x, prev.y + y,
    //                     (prev.x + point.x) / 2 + x,
    //                     (prev.y + point.y) / 2 + y);
    //             }
    //         }

    //         if (p === glyph.contourEnds[c]) {
    //             if (s === 2) { // final point was off-curve. connect to start
    //                 prev = point;
    //                 point = glyph.points[contourStart];
    //                 if (point.onCurve) {
    //                     ctx.quadraticCurveTo(prev.x + x, prev.y + y,
    //                         point.x + x, point.y + y);
    //                 } else {
    //                     ctx.quadraticCurveTo(prev.x + x, prev.y + y,
    //                         (prev.x + point.x) / 2 + x,
    //                         (prev.y + point.y) / 2 + y);
    //                 }
    //             }
    //             contourStart = p + 1;
    //             c += 1;
    //             s = 0;
    //         }
    //     }

    //     return true;
    // }

    private readGlyph(index: number): Glyph | null {
        var offset = this.getGlyphOffset(index);
        var file = this.f;
        let table = this.offsetTables["tables"]["glyf"];

        if (offset === 0 ||
            offset >= table["offset"] + table["length"]) {
            return null;
        }

        assert(offset >= table["offset"]);
        assert(offset < table["offset"] + table["length"]);

        file.seek(offset);

        var glyph = {
            contourEnds: [],
            numberOfContours: file.getInt16(),
            points: [],
            xMin: file.getInt16(),
            yMin: file.getInt16(),
            xMax: file.getInt16(),
            yMax: file.getInt16()
        };

        assert(glyph.numberOfContours >= -1);

        if (glyph.numberOfContours === -1) {
            this.readCompoundGlyph(file, glyph);
        } else {
            this.readSimpleGlyph(file, glyph);
        }

        return glyph;
    }


    private getGlyphOffset(index: number) {
        assert("loca" in this.offsetTables["tables"]);
        var table = this.offsetTables["tables"]["loca"];
        var file = this.f;
        var offset, old, next;

        if (this.tables["head"]["indexToLocFormat"] === 1) {
            old = file.seek(table["offset"] + index * 4);
            offset = file.getUint(4);
            next = file.getUint(4);
        } else {
            old = file.seek(table["offset"] + index * 2);
            offset = file.getUint(2) * 2;
            next = file.getUint(2) * 2;
        }

        file.seek(old);
        if (offset === next) {
            // indicates glyph has no outline( eg space)
            return 0;
        }

        //log("Offset for glyph index %s is %s", index, offset);

        return offset + this.offsetTables["tables"]["glyf"].offset;
    }

    private readCompoundGlyph(file: Slice, glyph: Glyph) {
        var ARG_1_AND_2_ARE_WORDS = 1,
            ARGS_ARE_XY_VALUES = 2,
            //ROUND_XY_TO_GRID = 4,
            WE_HAVE_A_SCALE = 8,
            // RESERVED              = 16
            MORE_COMPONENTS = 32,
            WE_HAVE_AN_X_AND_Y_SCALE = 64,
            WE_HAVE_A_TWO_BY_TWO = 128,
            WE_HAVE_INSTRUCTIONS = 256;
            //USE_MY_METRICS = 512,
            //OVERLAP_COMPONENT = 1024;

        var flags = MORE_COMPONENTS;
        var component;
        glyph.contourEnds = [];
        glyph.points = [];
        while (flags & MORE_COMPONENTS) {
            var arg1, arg2;

            flags = file.getUint(2);
            component = {
                glyphIndex: file.getUint(2),
                matrix: {
                    a: 1, b: 0, c: 0, d: 1, e: 0, f: 0
                },

                destPointIndex: 0,
                srcPointIndex: 0
            };

            if (flags & ARG_1_AND_2_ARE_WORDS) {
                arg1 = file.getInt16();
                arg2 = file.getInt16();
            } else {
                arg1 = file.getUint(1);
                arg2 = file.getUint(1);
            }

            if (flags & ARGS_ARE_XY_VALUES) {
                component.matrix.e = arg1;
                component.matrix.f = arg2;
            } else {
                component.destPointIndex = arg1;
                component.srcPointIndex = arg2;
            }

            if (flags & WE_HAVE_A_SCALE) {
                component.matrix.a = file.get2Dot14();
                component.matrix.d = component.matrix.a;
            } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
                component.matrix.a = file.get2Dot14();
                component.matrix.d = file.get2Dot14();
            } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
                component.matrix.a = file.get2Dot14();
                component.matrix.b = file.get2Dot14();
                component.matrix.c = file.get2Dot14();
                component.matrix.d = file.get2Dot14();
            }

            //log("Read component glyph index %s", component.glyphIndex);
            //log("Transform: [%s %s %s %s %s %s]", component.matrix.a, component.matrix.b,
            //    component.matrix.c, component.matrix.d, component.matrix.e, component.matrix.f);
            var old = file.tell();
            var simpleGlyph = this.readGlyph(component.glyphIndex);
            if (simpleGlyph) {
                var pointOffset = glyph.points.length;
                for (var i = 0; i < simpleGlyph.contourEnds.length; i++) {
                    glyph.contourEnds.push(simpleGlyph.contourEnds[i] +
                        pointOffset);
                }
                for (i = 0; i < simpleGlyph.points.length; i++) {
                    var x = simpleGlyph.points[i].x;
                    var y = simpleGlyph.points[i].y;
                    x = component.matrix.a * x + component.matrix.b * y +
                        component.matrix.e;
                    y = component.matrix.c * x + component.matrix.d * y +
                        component.matrix.f;
                    glyph.points.push({
                        x: x, y: y, onCurve:
                            simpleGlyph.points[i].onCurve
                    });
                }
            }

            file.seek(old);
        }

        glyph.numberOfContours = glyph.contourEnds.length;

        if (flags & WE_HAVE_INSTRUCTIONS) {
            file.seek(file.getUint(2) + file.tell());
        }
    }

    private readSimpleGlyph(file: Slice, glyph: Glyph) {

        var ON_CURVE = 1,
            X_IS_BYTE = 2,
            Y_IS_BYTE = 4,
            REPEAT = 8,
            X_DELTA = 16,
            Y_DELTA = 32;

        glyph.contourEnds = [];
        var points: Point[] = glyph.points = [];

        for (var i = 0; i < glyph.numberOfContours; i++) {
            glyph.contourEnds.push(file.getUint(2));
        }

        // skip over intructions
        file.seek(file.getUint(2) + file.tell());

        if (glyph.numberOfContours === 0) {
            return;
        }

        var numPoints = Math.max.apply(null, glyph.contourEnds) + 1;

        var flags: number[] = [];

        for (i = 0; i < numPoints; i++) {
            var flag = file.getUint(1);
            flags.push(flag);
            points.push({
                x: 0,
                y: 0,
                onCurve: (flag & ON_CURVE) > 0
            });

            if (flag & REPEAT) {
                var repeatCount = file.getUint(1);
                assert(repeatCount > 0);
                i += repeatCount;
                while (repeatCount--) {
                    flags.push(flag);
                    points.push({
                        x: 0,
                        y: 0,
                        onCurve: (flag & ON_CURVE) > 0
                    });
                }
            }
        }

        function readCoords(name: "x" | "y", byteFlag: number,
            deltaFlag: number) {
            var value = 0;

            for (var i = 0; i < numPoints; i++) {
                var flag = flags[i];
                if (flag & byteFlag) {
                    if (flag & deltaFlag) {
                        value += file.getUint(1);
                    } else {
                        value -= file.getUint(1);
                    }
                } else if (~flag & deltaFlag) {
                    value += file.getInt16();
                } else {
                    // value is unchanged.
                }

                points[i][name] = value;
            }
        }

        readCoords("x", X_IS_BYTE, X_DELTA);
        readCoords("y", Y_IS_BYTE, Y_DELTA);
    }

    getScale(fontHeight: number) {
        return fontHeight / this.tables["head"]["unitsPerEm"];
    }

    getHorizontalMetrics(glyphIndex: number) {
        //console.log("Offset tables: ", this.offsetTables["tables"])
        assert("hmtx" in this.offsetTables["tables"]);
        var file = this.f;
        var offset = this.offsetTables["tables"]["hmtx"].offset;
        var old = file.seek(offset + 4);
        let advanceWidth, leftSideBearing;
        let numOfLongHorMetrics = this.tables["hhea"]["numOfLongHorMetrics"];
        if (glyphIndex < numOfLongHorMetrics) {
            offset += glyphIndex * 4;
            old = this.f.seek(offset);
            advanceWidth = file.getUint(2);
            leftSideBearing = file.getInt16();
        } else {
            // read the last entry of the hMetrics array
            old = file.seek(offset + (numOfLongHorMetrics - 1) * 4);
            advanceWidth = file.getUint(2);
            file.seek(offset + numOfLongHorMetrics * 4 +
                2 * (glyphIndex - numOfLongHorMetrics));
            leftSideBearing = file.getInt16();
        }

        file.seek(old);
        return {
            advanceWidth: advanceWidth,
            leftSideBearing: leftSideBearing
        };
    }

    getGlyphIndex(charCode: number) {
        var index = 0;
        // start at the last CMAP first, which is typically the full featured one that supports unicode.
        for (var i = this.cmaps.length - 1; i >= 0; i--) {
            var cmap = this.cmaps[i];
            index = cmap.map(charCode);
            if (index) {
                break;
            }
        }
        return index;
    }

    // drawText(ctx: ICanvasContext, text: string, x: number, y: number,
    //     size: number) {
    //     ctx.save();
    //     ctx.translate(x, y);
    //     this.transform(ctx, size);
    //     let glyphs: KernAdjustment[] = [];
    //     for (var i = 0; i < text.length; i++) {
    //         glyphs.push(new KernAdjustment(this.getGlyphIndex(text.charCodeAt(i))));
    //     }

    //     for (let kerner of this.kerners) {
    //         kerner.kern(glyphs);
    //     }

    //     x = 0;
    //     y = 0;
    //     for (let i = 0; i < glyphs.length; i++) {
    //         let glyph = glyphs[i];
    //         var metrics = this.getHorizontalMetrics(glyph.glyph);
    //         log("Metrics for %s code %s index %s: %s %s", text.charAt(i),
    //             text.charCodeAt(i), glyph.glyph, metrics.advanceWidth, metrics.leftSideBearing);
    //         this.drawGlyph(ctx, glyph.glyph, x + glyph.placement.x, y + glyph.placement.y);
    //         x += metrics.advanceWidth + glyph.advance.x;
    //         y += glyph.advance.y;
    //     }
    //     ctx.restore();
    // }
}

// Implements CMAP0 format, mapping unicode to a glyph index using an array.
class CMap0 implements CMap {
    constructor(private f: Slice) { }

    map(charCode: number) {
        if (charCode >= 0 && charCode <= 255) {
            this.f.seek(charCode + 6);
            log("charCode %s maps to %s", charCode, this.f.getUint(1));
            this.f.seek(charCode + 6);
            return this.f.getUint(1);
        }
        return 0;
    }
}

// Implements CMAP4 format, mapping unicode to a glyph index using a list of
// numerical ranges.
class CMap4 implements CMap {
    private segCount: number;
    constructor(private f: Slice) {
        f.seek(6);
        this.segCount = f.getUint(2) / 2;
    }

    map(charCode: number) {
        log("Try to map charcode %s using %s ranges", charCode, this.segCount);
        let f = this.f, start = 0, result = 0;
        let i = bsearch(this.segCount - 1, (i) => {
            f.seek(14 + i * 2);
            let end = f.getUint(2);
            f.seek(14 + this.segCount * 2 + 2 + i * 2);
            start = f.getUint(2);
            if (charCode < start) {
                return -1;
            } else if (charCode > end) {
                return 1;
            }
            return 0;
        })

        if (i >= 0) {
            f.seek(14 + this.segCount * 3 * 2 + 2 + i * 2);
            const rangeOffset = f.getUint(2);
            f.seek(14 + this.segCount * 2 * 2 + 2 + i * 2);
            const delta = f.getInt16();
            if (rangeOffset === 0) {
                result = (delta + charCode) & 0xffff;
            } else {
                let ptr = 14 + this.segCount * 3 * 2 + 2 + i * 2;
                ptr += (charCode - start) * 2 + rangeOffset;
                f.seek(ptr);
                result = f.getUint(2);
                if (result !== 0) {
                    result = (result + delta) & 0xffff;
                }
            }
        }
        return result;
    }
}

/** @param cmp returns target - i */
function bsearch(count: number, cmp: (i: number) => number): number {
    let high = count, low = -1, probe: number;

    while (high - low > 1) {
        probe = (high + low) >> 1;

        const match = cmp(probe);

        if (match == 0) {
            return probe;
        } else if (match > 0) {
            low = probe;
        } else {
            high = probe;
        }
    }
    return -1;
}

/**
 CFF string is a collection of machine code instructions to render a font. They
 can call into subroutines marked "local" or "global". This reads the headers
 containing the description of the font, all of the instructions. It implements
 the drawGlyph function for CFF fonts.
 */
class CFFString {
    dicts: number;
    strings: number; // string index
    subs: number;
    topDict: any;
    numGlyphs: number;
    fdSelect: FDSelect | null = null;
    fdDicts: any[] = [];

    constructor(private f: Slice) {
        const major = f.getUint(1);
        const minor = f.getUint(1);
        const hdrSize = f.getUint(1);
        log(`CFF Version ${major}.${minor}`);
        f.seek(hdrSize);
        f.indexSkip(); // name index
        this.dicts = f.indexSkip(); // font dicts
        this.strings = f.indexSkip(); // string index
        this.subs = f.tell();
        let topDict = this.topDict = this.readDict(f.indexSeek(this.dicts, 0));
        this.numGlyphs = f.getIndexCount(topDict["CharStrings"]);
        log(`CFF Font contains ${this.numGlyphs} glyphs`);
        if (this.topDict["FDSelect"]) {
            this.fdSelect = new FDSelect(f.slice(topDict["FDSelect"]));
            this.readFDArray(f, topDict);
        } else {
            this.fdDicts.push(topDict);
        }

    }

    readDict(f: Slice) {
        let dict = ReadCFFDict(f, {}, this);
        if (dict["Private"]) {
            let length = dict["Private"][0];
            let offset = dict["Private"][1];
            ReadCFFDict(this.f.slice(offset, length), dict, this);
            if (dict["Subrs"]) {
                dict["Subrs"] += offset;
            }
        }
        return dict;
    }

    getString(n: number) {
        if (n < STDSTRINGS.length) {
            return STDSTRINGS[n];
        }
        const slice = this.f.indexSeek(this.strings, n - STDSTRINGS.length);
        return slice.getString(slice.length);
    }

    readFDArray(f: Slice, topDict: any) {
        let fdindex = topDict["FDArray"];
        let count = f.getIndexCount(fdindex);
        log("There are %s items in FDArray", count);
        for (let i = 0; i < count; i++) {
            this.fdDicts.push(this.readDict(f.indexSeek(fdindex, i)));
        }
    }

    /** @param subNumber Is the unbiased number of the subroutine
     *  @param fontIndex is -1 for a global sub, or the font glyphs FD index
     *                for a local sub.
     */
    getSubr(subNumber: number, fontIndex: number = -1): Slice {
        let subIndex: number;
        let charStringType: number;
        if (fontIndex === -1) {
            subIndex = this.subs;
            charStringType = this.topDict["CharstringType"];
        } else {
            let dict = this.fdDicts[fontIndex];
            subIndex = dict["Subrs"];
            charStringType = dict["CharstringType"];
        }

        let count = this.f.getIndexCount(subIndex);
        subNumber += GetBias(charStringType, count);
        //log("Subindex for font %s has %s entries. Call sub# %s", fontIndex, count, subNumber);
        return this.f.indexSeek(subIndex, subNumber);
    }

    getFontNumber(glyph: number) {
        if (this.fdSelect) {
            return this.fdSelect.lookup(glyph);
        }
        return 0; // top dict in 0th entry of fdDicts
    }

    // drawGlyph(ctx: ICanvasContext, glyphIndex: number, x: number, y: number) {
    //     ctx.translate(x, y);
    //     let index = this.topDict["CharStrings"];
    //     let fontNumber = this.getFontNumber(glyphIndex);
    //     DrawCFFGlyph(this.f.indexSeek(index, glyphIndex), ctx, fontNumber, this);
    //     ctx.translate(-x, -y);
    // }
}

type OpType = number;
const SID = 0;
const BOOLEAN = 1;
const NUMBER = 2;
const ARRAY = 3;

interface Instruction {
    type: OpType[];
    name: string;
    def: any;
    fn: (dict: any, args: number[]) => void;
}

const DICT_INSTRUCTIONS: { [code: number]: Instruction } = {};

function assign(name: string, code: number, typeIn: OpType | OpType[], def?: any) {
    const array = typeIn instanceof Array;
    DICT_INSTRUCTIONS[code] = {
        name: name,
        def: def,
        type: (array ? typeIn : [typeIn]) as OpType[],
        fn: (dict: any, args: any[]) => {
            //console.log(`Assign ${name}=${JSON.stringify(args)}`);
            dict[name] = array || typeIn === ARRAY ? args : args[0];
        }
    }
};

assign("version", 0, SID);
assign("Notice", 1, SID);
assign("Copyright", 0xC | 0, SID);
assign("FullName", 2, SID);
assign("FamilyName", 3, SID);
assign("Weight", 4, SID);
assign("isFixedPitch", 0xc00 | 1, BOOLEAN, false);
assign("ItalicAngle", 0xc00 | 2, NUMBER, 0);
assign("UnderlinePosition", 0xc00 | 3, NUMBER, -100);
assign("UnderlineThickness", 0xc00 | 4, NUMBER, 50);
assign("PaintType", 0xc00 | 5, NUMBER, 0);
assign("CharstringType", 0xc00 | 6, NUMBER, 2);
assign("FontMatrix", 0xc00 | 7, ARRAY, [0.001, 0, 0, 0.001, 0, 0]);
assign("UniqueID", 13, NUMBER);
assign("FontBBox", 5, ARRAY, [0, 0, 0, 0]);
assign("StrokeWidth", 0xc00 | 8, NUMBER, 0);
assign("XUID", 14, ARRAY);
assign("charset", 15, NUMBER, 0);
assign("Encoding", 16, NUMBER, 0)
assign("CharStrings", 17, NUMBER, 0);
assign("Private", 18, [NUMBER, NUMBER]);
assign("SyntheticBase", 0xc00 | 20, NUMBER);
assign("PostSCript", 0xc00 | 21, SID);
assign("BaseFontName", 0xc00 | 22, SID);
assign("BaseFontBlend", 0xc00 | 23, SID);
assign("ROS", 0xc00 | 30, [SID, SID]);
assign("CIDFontVersion", 0xc00 | 31, NUMBER, 0);
assign("CIDFontRevision", 0xc00 | 32, NUMBER, 0);
assign("CIDFontType", 0xc00 | 33, NUMBER, 0);
assign("CIDCount", 0xc00 | 34, NUMBER);
assign("FDArray", 0xc00 | 36, NUMBER);
assign("FDSelect", 0xc00 | 37, NUMBER);
assign("FontName", 0xc00 | 38, SID);

// private
assign("BlueValues", 6, NUMBER);
assign("OtherBlues", 7, NUMBER);
assign("FamilyBlues", 8, NUMBER);
assign("FamilyOtherBlues", 9, NUMBER);
assign("BlueScale", 0xc09, NUMBER, 0.039625);
assign("BlueShift", 0xc0a, 8);
assign("BlueFuzz", 0xc01, 1);
assign("StdHW", 10, NUMBER);
assign("StdVW", 11, NUMBER);
assign("StemSnapH", 0xc0c, NUMBER);
assign("StemSnapV", 0xc0d, NUMBER);
assign("ForceBold", 0xc0e, BOOLEAN, false);
assign("LanguageGroup", 0xc11, NUMBER, 0);
assign("ExpansionFactor", 0xc12, NUMBER, 0.6);
assign("initialRandomSeed", 0xc13, NUMBER, 0);
assign("Subrs", 19, NUMBER);
assign("defaultWidthX", 20, NUMBER);
assign("NominalWidthX", 21, NUMBER);

interface StringGetter {
    getString(n: number): string;
}

function ReadCFFDict(f: Slice, dict: any, strings: StringGetter) {
    while (!f.eof()) {
        const op = f.getInstruction();
        if (op.code in DICT_INSTRUCTIONS) {
            let instr = DICT_INSTRUCTIONS[op.code];
            let args: any[] = [];
            outer:
            for (let i = 0; i < instr.type.length; i++) {
                let type = instr.type[i];
                if (i >= op.operands.length) {
                    throw new Error("Not enough operands for instruction:" + op);
                }
                let arg = op.operands[i];
                switch (type) {
                    case SID:
                        args.push(strings.getString(arg));
                        break;
                    case BOOLEAN:
                        args.push(!!arg);
                        break;
                    case ARRAY:
                        args = op.operands;
                        break outer;
                    case NUMBER:
                        args.push(arg);
                        break;
                }
            }
            instr.fn(dict, args);
        } else {
            log("Uknown dict opcode: %s", op.code);
        }
    }
    for (let key in DICT_INSTRUCTIONS) {
        let instr = DICT_INSTRUCTIONS[key];
        if (instr.def && !(instr.name in dict)) {
            dict[instr.name] = instr.def;
        }
    }
    return dict;
}

interface SubGetter {
    getSubr(subIndex: number, fontNumber: number): Slice;
}

interface MachineState {
    first: boolean; // has first stack-clearing instruction been executed?

    width: number;
    numHints: number;
    stack: number[];
    x: number;
    y: number;
    started: boolean;
    startX: number;
    startY: number;
}

/*
let DRAWCODES: { [key: number]: string } = {
    7: "vlineto",
    10: "callsubr",
    18: "hstemhm",
    19: "hintmask",
    21: "rmoveto",
    26: "vvcurveto",
    5: "rlineto",
    30: "vhcurveto",
    31: "hcurveto",
    14: "endchar",
}
*/

// function DrawCFFGlyph(f: Slice, ctx: ICanvasContext, fontNumber: number, subs: SubGetter, s?: MachineState) {
//     s = s || {
//         first: true,
//         width: 0,
//         numHints: 0,
//         stack: [],
//         x: 0,
//         y: 0,
//         started: false,
//         startX: 0,
//         startY: 0,
//     };

//     while (!f.eof()) {
//         let op = f.getInstruction(true, s.stack);
//         //log("Exec opcode %s [%s] %s", op.code, DRAWCODES[op.code], JSON.stringify(s.stack));
//         switch (op.code) {
//             case 1: // hstem
//             case 3: // vstem
//                 if (s.stack.length & 1) getWidth(s);
//                 break;
//             case 4: // vmoveto
//                 if (s.stack.length > 1) getWidth(s);
//                 s.y += s.stack[0];
//                 moveto(s, ctx);
//                 break;
//             case 5: // rlineto
//                 for (let i = 0; i + 1 < s.stack.length; i += 2) {
//                     s.x += s.stack[i];
//                     s.y += s.stack[i + 1];
//                     ctx.lineTo(s.x, s.y);
//                 }
//                 break;
//             case 6: // hlineto
//                 for (let i = 0; i < s.stack.length; i += 2) {
//                     s.x += s.stack[i];
//                     ctx.lineTo(s.x, s.y);
//                     if (i + 1 < s.stack.length) {
//                         s.y += s.stack[i + 1];
//                         ctx.lineTo(s.x, s.y);
//                     }
//                 }
//                 break;
//             case 7: // vlineto
//                 for (let i = 0; i < s.stack.length; i += 2) {
//                     s.y += s.stack[i];
//                     ctx.lineTo(s.x, s.y);
//                     if (i + 1 < s.stack.length) {
//                         s.x += s.stack[i + 1];
//                         ctx.lineTo(s.x, s.y);
//                     }
//                 }
//                 break;
//             case 8: // rrcurveto
//                 rrcurve(s, ctx);
//                 break;
//             case 10: // callsubr
//                 DrawCFFGlyph(subs.getSubr(s.stack.pop()!, fontNumber), ctx, fontNumber, subs, s);
//                 continue; // don't clear stack
//             case 11: // return
//                 return;
//             case 14: // endchar
//                 if (s.stack.length) getWidth(s);
//                 endpath(s, ctx);
//                 break;
//             case 18: // hstemhm
//             case 23: // vstemhm
//                 if (s.stack.length & 1) getWidth(s);
//                 s.numHints += s.stack.length >> 1;
//                 break;
//             case 19: // hintmask
//             case 20: // cntrmask
//                 if (s.stack.length & 1) getWidth(s);
//                 s.numHints += s.stack.length >> 1;  // optional vstem values
//                 const numSkip = (s.numHints + 7) >> 3;
//                 for (let i = 0; i < numSkip; i++) {
//                     f.getUint(1);
//                 }
//                 break;
//             case 21: // rmoveto
//                 if (s.stack.length & 1) getWidth(s);
//                 s.x += s.stack[0];
//                 s.y += s.stack[1];
//                 moveto(s, ctx);
//                 break;
//             case 22: // hmoveto
//                 if (s.stack.length === 2) getWidth(s);
//                 s.x += s.stack[0];
//                 moveto(s, ctx);
//                 break;
//             case 24: // rcurveline
//                 rrcurve(s, ctx);
//                 s.y += s.stack.pop()!;
//                 s.x += s.stack.pop()!;
//                 ctx.lineTo(s.x, s.y);
//                 break;
//             case 25: { // rlinecurve
//                 for (var i = 0; i < s.stack.length - 6; i += 2) {
//                     s.x += s.stack[i];
//                     s.y += s.stack[i + 1];
//                     ctx.lineTo(s.x, s.y);
//                 }
//                 rrcurve(s, ctx, i);
//                 break;
//             }
//             case 26: { // vvcurveto 
//                 let i = s.stack.length & 1;
//                 if (i) {
//                     s.x += s.stack[0];
//                 }
//                 for (; i < s.stack.length; i += 4) {
//                     const dxa = s.x;
//                     const dya = s.y += s.stack[i + 0];
//                     const dxb = s.x += s.stack[i + 1];
//                     const dyb = s.y += s.stack[i + 2];
//                     const dxc = s.x;
//                     const dyc = s.y += s.stack[i + 3];
//                     ctx.bezierCurveTo(dxa, dya, dxb, dyb, dxc, dyc);
//                 }
//                 break;
//             }
//             case 27: { // hhcurveto
//                 let i = s.stack.length & 1;
//                 if (i) {
//                     s.y += s.stack[0];
//                 }
//                 for (; i < s.stack.length; i += 4) {
//                     const dxa = s.x += s.stack[i + 0];
//                     const dya = s.y;
//                     const dxb = s.x += s.stack[i + 1];
//                     const dyb = s.y += s.stack[i + 2];
//                     const dxc = s.x += s.stack[i + 3];
//                     const dyc = s.y;
//                     ctx.bezierCurveTo(dxa, dya, dxb, dyb, dxc, dyc);
//                 }
//                 break;
//             }
//             case 29: // callgsubr
//                 DrawCFFGlyph(subs.getSubr(s.stack.pop()!, -1), ctx, fontNumber, subs, s);
//                 continue;
//             case 30: // vhcurveto
//                 xxcurveto(s, false, ctx);
//                 break;
//             case 31: // hvcurveto
//                 xxcurveto(s, true, ctx);
//                 break;
//             case 0xc03: // and
//             case 0xc04: // or
//             case 0xc05: // not
//             case 0xc09: // abs
//             case 0xc0a: // add
//             case 0xc0b: // sub
//             case 0xc0c: // div
//             case 0xc0e: // neg
//             case 0xc0f: // eq
//             case 0xc12: // drop
//             case 0xc14: // put
//             case 0xc15: // get
//             case 0xc16: // ifelse
//             case 0xc17: // random
//             case 0xc18: // mul
//             case 0xc1a: // sqrt
//             case 0xc1b: // dup
//             case 0xc1c: // exch
//             case 0xc1d: // index
//             case 0xc1e: // roll
//             case 0xc22: // hflex
//             case 0xc23: // flex
//             case 0xc24: // hflex1
//             case 0xc25: // flex1
//                 todo();
//                 break;
//         }

//         s.stack.length = 0;
//     }
// }

/** 
 CFF font outlines don't end at their start. So before we move to another
 position, close off any existing paths.
 */
// function moveto(s: MachineState, ctx: ICanvasContext) {
//     endpath(s, ctx);
//     s.startX = s.x;
//     s.startY = s.y;
//     s.started = true;
//     ctx.moveTo(s.x, s.y);
// }

// function endpath(s: MachineState, ctx: ICanvasContext) {
//     if (s.started) {
//         ctx.lineTo(s.startX, s.startY);
//     }
// }

// function rrcurve(s: MachineState, ctx: ICanvasContext, i = 0) {
//     for (; i + 5 < s.stack.length; i += 6) {
//         const dxa = s.x += s.stack[i + 0];
//         const dya = s.y += s.stack[i + 1];
//         const dxb = s.x += s.stack[i + 2];
//         const dyb = s.y += s.stack[i + 3];
//         const dxc = s.x += s.stack[i + 4];
//         const dyc = s.y += s.stack[i + 5];
//         ctx.bezierCurveTo(dxa, dya, dxb, dyb, dxc, dyc);
//     }
// }

// function xxcurveto(s: MachineState, h: boolean, ctx: ICanvasContext) {
//     for (let i = 0; i + 1 < s.stack.length; i += 4) {
//         const last = i == s.stack.length - 5;
//         if (h) {
//             const dxa = s.x += s.stack[i + 0];
//             const dya = s.y;
//             const dxb = s.x += s.stack[i + 1];
//             const dyb = s.y += s.stack[i + 2];
//             const dxc = last ? s.x += s.stack[i + 4] : s.x;
//             const dyc = s.y += s.stack[i + 3];
//             ctx.bezierCurveTo(dxa, dya, dxb, dyb, dxc, dyc);
//         } else {
//             const dxa = s.x;
//             const dya = s.y += s.stack[i + 0];
//             const dxb = s.x += s.stack[i + 1];
//             const dyb = s.y += s.stack[i + 2];
//             const dxc = s.x += s.stack[i + 3];
//             const dyc = last ? s.y += s.stack[i + 4] : s.y;
//             ctx.bezierCurveTo(dxa, dya, dxb, dyb, dxc, dyc);
//         }
//         h = !h;
//     }
// }

function todo() {
    throw new Error("Not implemented.")
}
function getWidth(s: MachineState) {
    if (!s.first) {
        log("Warning; already have width");
        s.stack.shift();
        return;
        //throw new Error("Error: Already got width arg.");
    }
    //log("Got width: " + s.stack[0]);
    s.width = s.stack.shift()!;
    s.first = false;
}


class FDSelect {
    /** @param f Already sliced binary reader */
    format: number;
    nRanges = 0;
    constructor(private f: Slice) {
        this.format = f.getUint(1);
        log("Reading FDSelect format %s", this.format);
        if (this.format !== 3 && this.format !== 0) {
            throw new Error(`Can't read format ${this.format} FDSelect`);
        }

        if (this.format === 3) {
            this.nRanges = f.getUint(2);
        }
    }

    lookup(target: number) {
        if (this.format === 0) {
            this.f.seek(1 + target);
            return this.f.getUint(1);
        }

        let fd = -1;
        bsearch(this.nRanges, (n) => {
            this.f.seek(3 + 3 * n);
            let first = this.f.getUint(2);
            fd = this.f.getUint(1);
            let next = this.f.getUint(2);
            if (target < first) {
                return -1;
            } else if (target >= next) {
                return 1;
            }
            return 0;
        });
        return fd;
    }
}

/**
 To save space, CFF font subroutine numbers are offset by a certain fixed number.
 This adds that number back in.
 */
function GetBias(charStringType: number, count: number): number {
    if (charStringType === 0) {
        return 0;
    } else if (count < 1240) {
        return 107;
    } else if (count < 33900) {
        return 1131;
    }
    return 32768;
}

const STDSTRINGS = `.notdef space exclam quotedbl numbersign dollar percent ampersand quoteright 
parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven 
eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U
V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f g h i j k 
l m n o p q r s t u v w x y z braceleft bar braceright asciitilde exclamdown cent sterling fraction
yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi
fl endash dagger daggerdbl periodcentered paragraph bullet quotesinglbase quotedblbase quotedblright
guillemotright ellipsis perthousand questiondown grave acute circumflex tilde macron breve dotaccent 
dieresis ring cedilla hungarumlaut ogonek caron emdash AE ordfeminine Lslash Oslash OE ordmasculine 
ae dotlessi lslash oslash oe germandbls onesuperior logicalnot mu trademark Eth onehalf plusminus 
Thorn onequarter divide brokenbar degree thorn threequarters twosuperior registered minus eth 
multiply threesuperior copyright Aacute Acircumflex Adieresis Agrave Aring Atilde Ccedilla Eacute 
Ecircumflex Edieresis Egrave Iacute Icircumflex Idieresis Igrave Ntilde Oacute Ocircumflex 
Odieresis Ograve Otilde Scaron Uacute Ucircumflex Udieresis Ugrave Yacute Ydieresis Zcaron aacute 
acircumflex adieresis agrave aring atilde ccedilla eacute ecircumflex edieresis egrave iacute 
icircumflex idieresis igrave ntilde oacute ocircumflex odieresis ograve otilde scaron uacute 
ucircumflex udieresis ugrave yacute ydieresis zcaron exclamsmall Hungarumlautsmall dollaroldstyle 
dollarsuperior ampersandsmall Acutesmall parenleftsuperior parenrightsuperior twodotenleader 
onedotenleader zerooldstyle oneoldstyle twooldstyle threeoldstyle fouroldstyle fiveoldstyle 
sixoldstyle sevenoldstyle eightoldstyle nineoldstyle commasuperior threequartersemdash 
periodsuperior questionsmall asuperior bsuperior centsuperior dsuperior esuperior isuperior 
lsuperior msuperior nsuperior osuperior rsuperior ssuperior tsuperior ff ffi ffl parenleftinferior 
parenrightinferior Circumflexsmall hyphensuperior Gravesmall Asmall Bsmall Csmall Dsmall Esmall 
Fsmall Gsmall Hsmall Ismall Jsmall Ksmall Lsmall Msmall Nsmall Osmall Psmall Qsmall Rsmall Ssmall 
Tsmall Usmall Vsmall Wsmall Xsmall Ysmall Zsmall colonmonetary onefitted rupiah Tildesmall 
exclamdownsmall centoldstyle Lslashsmall Scaronsmall Zcaronsmall Dieresissmall Brevesmall Caronsmall 
Dotaccentsmall Macronsmall figuredash hypheninferior Ogoneksmall Ringsmall Cedillasmall 
questiondownsmall oneeighth threeeighths fiveeighths seveneighths onethird twothirds zerosuperior 
foursuperior fivesuperior sixsuperior sevensuperior eightsuperior ninesuperior zeroinferior 
oneinferior twoinferior threeinferior fourinferior fiveinferior sixinferior seveninferior 
eightinferior nineinferior centinferior dollarinferior periodinferior commainferior Agravesmall 
Aacutesmall Acircumflexsmall Atildesmall Adieresissmall Aringsmall AEsmall Ccedillasmall Egravesmall 
Eacutesmall Ecircumflexsmall Edieresissmall Igravesmall Iacutesmall Icircumflexsmall Idieresissmall 
Ethsmall Ntildesmall Ogravesmall Oacutesmall Ocircumflexsmall Otildesmall Odieresissmall OEsmall 
Oslashsmall Ugravesmall Uacutesmall Ucircumflexsmall Udieresissmall Yacutesmall Thornsmall 
Ydieresissmall 001.000 001.001 001.002 001.003 Black Bold Book Light Medium Regular Roman Semibold`.
    split(/\s+/);

const GPOS_TABLE = `{
    majorVersion:uint16
    minorVersion:uint16
    scriptListOffset:uint16
    featureListOffset:uint16
    lookupListOffset:uint16
    featureVariationsOffset:uint16

    push scriptListOffset
    scriptCount:uint16
    scriptRecords:[scriptCount] {
        tag:string(4)
        scriptOffset:uint16
        push scriptOffset
        defaultLangSys:uint16
        langSysCount:uint16
        langSysRecords:[langSysCount] {
            langSysTag:string(4)
            langSysOffset:uint16
            push langSysOffset
            lookupOrder:uint16
            requiredFeatureIndex:uint16
            featureIndexCount:uint16
            featureIndices:[featureIndexCount] uint16
            pop
        }
        pop
    }
    pop

    push lookupListOffset
    lookupCount:uint16
    lookups:[lookupCount] {
        offset:uint16
        push offset
        lookupType:uint16
        lookupFlag:uint16
        subTableCount:uint16
        subTables:[subTableCount] {
            offset:uint16
            push offset
            posFormat:uint16
            coverageOffset:uint16
        }
        pop
    }
    pop

    push featureListOffset
    featureCount:uint16
    featureRecords[featureCount] {
        featureTag:string(4)
        featureOffset:uint16
        push featureOffset
        featureParams:uint16
        lookupIndexCount:uint16
        lookupListIndicies:[lookupIndexCount] uint16
        pop
    }
    pop
}`

class KernAdjustment {
    constructor(public glyph: number) { }
    placement = { x: 0, y: 0 };
    advance = { x: 0, y: 0 };
}

interface KernAdjuster {
    kern(glyphs: KernAdjustment[]): void;
}

class GPOS implements KernAdjuster {
    header: any;
    adjusters: KernAdjuster[] = [];
    constructor(input: Slice) {
        this.header = decode(input, GPOS_TABLE);
        let offset = this.header["lookupListOffset"];
        for (let lookup of this.header["lookups"]) {
            let loffset = offset + lookup["offset"];
            let type = lookup["lookupType"];
            log("Lookup type %s has %s subtables", type, lookup["subTables"].length);
            for (let subtable of lookup["subTables"]) {
                let soffset = loffset + subtable["offset"];
                if (type === 2 && subtable["posFormat"] === 1) {
                    this.adjusters.push(new LookupType2_1(input.slice(soffset)));
                } else if (type === 2 && subtable["posFormat"] === 2) {
                    this.adjusters.push(new LookupType2_2(input.slice(soffset)));
                }
            }
        }
    }

    kern(glyphs: KernAdjustment[]) {
        for (let adjuster of this.adjusters) {
            adjuster.kern(glyphs);
        }
    }
}

class CoverageTable {
    format: number;
    count: number;
    headersize = 4;
    constructor(private f: Slice) {
        this.format = f.getUint(2);
        this.count = f.getUint(2);
        log("CoverageTable format %s count %s", this.format, this.count);
    }

    getCoverageIndex(glyph: number) {
        let index = -1;
        if (this.format === 1) {
            bsearch(this.count, (i: number) => {
                this.f.seek(this.headersize + i * 2);
                let j = this.f.getUint(2);
                if (glyph < j) {
                    return -1;
                } else if (glyph > j) {
                    return 1;
                }
                index = j;
                return 0;
            });
        } else {
            bsearch(this.count, (i: number) => {
                this.f.seek(this.headersize + i * 6);
                let start = this.f.getUint(2);
                this.f.getUint(2); // end
                let first = this.f.getUint(2);
                if (glyph < start) {
                    return -1;
                } else if (glyph > start) {
                    return 1;
                }
                index = first + glyph - start;
                return 0;
            })
        }
        return index;
    }
}

// Since this is so similar to the Coverage table formats
// we can reuse the code.
class ClassDefTable extends CoverageTable {
    startGlyph = 0
    constructor(f: Slice) {
        super(f)
        if (this.format === 1) {
            this.startGlyph = this.count;
            this.count = f.getUint(2);
            this.headersize += 2;
        }
    }

    getClass(glyph: number) {
        return Math.max(0, this.getCoverageIndex(glyph - this.startGlyph));
    }
}

function readValueRecord(f: Slice, kern: KernAdjustment, format: number) {
    if (format & 1) kern.placement.x = f.getInt16();
    if (format & 2) kern.placement.y = f.getInt16();
    if (format & 4) kern.advance.x = f.getInt16();
    if (format & 8) kern.advance.y = f.getInt16();
    if (format & 16) f.getInt16();
    if (format & 32) f.getInt16();
    if (format & 64) f.getInt16();
    if (format & 128) f.getInt16();
}

abstract class PairKerner {
    kern(glyphs: KernAdjustment[]) {
        for (let i = 0; i < glyphs.length - 1; i++) {
            this.lookup(glyphs[i], glyphs[i + 1]);
        }
    }
    abstract lookup(glyph1: KernAdjustment, glyph2: KernAdjustment): number
}

// Pair adjustment positioning pos format 1
class LookupType2_1 extends PairKerner {
    coverage: CoverageTable
    valueFormat1: number;
    valueFormat2: number;
    count: number;
    recordLength: number;
    constructor(private f: Slice) {
        super()

        f.getUint(2); // format = 1
        let coverage = f.getUint(2);
        this.coverage = new CoverageTable(f.slice(coverage));
        this.valueFormat1 = f.getUint(2);
        this.valueFormat2 = f.getUint(2);
        this.count = f.getUint(2);
        this.recordLength = bitCount(this.valueFormat1) * 2 + bitCount(this.valueFormat2) * 2 + 2;
    }


    lookup(glyph1: KernAdjustment, glyph2: KernAdjustment) {
        // first, find glyph1 in coverage
        let glyph1Coverage = this.coverage.getCoverageIndex(glyph1.glyph);
        if (glyph1Coverage === -1) {
            return 0;
        }

        // now seek to its pairset table
        this.f.seek(10 + 2 * glyph1Coverage);
        this.f.seek(this.f.getUint(2));
        const at = this.f.tell();

        let count = this.f.getUint(2);
        let found = bsearch(count, (i) => {
            this.f.seek(at + i * this.recordLength);
            let secondGlyph = this.f.getUint(2);
            if (secondGlyph < glyph2.glyph) {
                return -1;
            } else if (secondGlyph > glyph2.glyph) {
                return 1;
            }
            readValueRecord(this.f, glyph1, this.valueFormat1);
            readValueRecord(this.f, glyph2, this.valueFormat2);
            return 0;
        });

        return found >= 0 ? 1 : 0;
    }
}

class LookupType2_2 extends PairKerner {
    coverage: CoverageTable
    classDef1: ClassDefTable
    classDef2: ClassDefTable
    class1Count: number
    class2Count: number
    valueFormat1: number
    valueFormat2: number
    recordSize: number;
    constructor(private f: Slice) {
        super();
        f.getUint(2); // format
        this.coverage = new CoverageTable(f.slice(f.getUint(2)));
        this.valueFormat1 = f.getUint(2);
        this.valueFormat2 = f.getUint(2);
        this.classDef1 = new ClassDefTable(f.slice(f.getUint(2)));
        this.classDef2 = new ClassDefTable(f.slice(f.getUint(2)));
        this.class1Count = f.getUint(2);
        this.class2Count = f.getUint(2);
        this.recordSize = bitCount(this.valueFormat1) * 2 + bitCount(this.valueFormat2) * 2;
    }

    lookup(glyph1: KernAdjustment, glyph2: KernAdjustment) {
        let glyph1Coverage = this.coverage.getCoverageIndex(glyph1.glyph);
        if (glyph1Coverage === -1) return 0;

        let glyph1Class = this.classDef1.getClass(glyph1.glyph);
        let glyph2Class = this.classDef2.getClass(glyph2.glyph);

        this.f.seek(16 + glyph1Class * this.recordSize * this.class2Count + glyph2Class * this.recordSize);
        readValueRecord(this.f, glyph1, this.valueFormat1);
        readValueRecord(this.f, glyph2, this.valueFormat2);
        return 1;
    }
}

class Kern0 extends PairKerner {
    constructor(
        private f: Slice,
        private count = f.getUint(2)
    ) {
        super();
        log("Kern table has %s entries", this.count);
    }

    lookup(glyph1: KernAdjustment, glyph2: KernAdjustment) {
        let key = (glyph1.glyph << 16) | glyph2.glyph;
        let ret = 0;
        bsearch(this.count, (i) => {
            this.f.seek(8 + 6 * i);
            let rec = this.f.getUint(4);
            if (key < rec) {
                return -1;
            } else if (key > rec) {
                return 1;
            }

            let shift = this.f.getInt16();
            glyph2.placement.x += shift;
            glyph2.advance.x += shift;
            ret = 1;
            return 0;
        })

        return ret;
    }

}

function bitCount(n: number) {
    n = n - ((n >> 1) & 0x55555555)
    n = (n & 0x33333333) + ((n >> 2) & 0x33333333)
    return ((n + (n >> 4) & 0xF0F0F0F) * 0x1010101) >> 24
}