// ref: http://stevehanov.ca/blog/?id=143 

async function fetch_arraybuffer(uri: string): Promise<ArrayBuffer> {
    return await (await fetch(uri)).arrayBuffer();
}

type font_table = { [key: string]: { checksum: number, offset: number, length: number } };

interface font_truetype {
    version: number;
    font_revision: number;
    checksum_adjustment: number;
    magic_number: number;

    flags: number;
    units_per_em: number;
    created: Date;
    modified: Date;
    
    x_min: number;
    y_min: number;
    x_max: number;
    y_max: number;

    mac_style: number;
    lowest_rec_ppem: number;
    font_direction_hint: number;
    index_to_loc_format: number;
    glyph_data_format: number;
}

interface glyph_point {
    on_curve: boolean;
    x: number;
    y: number;
}

interface glyph {
    contour_count: number;
    x_min: number;
    y_min: number;
    x_max: number;
    y_max: number;
    
    type: 'simple' | 'compound';
    contour_ends: number[];
    points: glyph_point[];
}

interface font_parser {
    pos: number;
    data: Uint8Array;

    font: font_truetype;

    // properties
    scalar_type: number;
    search_range: number;
    entry_selector: number;
    range_shift: number;

    tables: font_table;
}

function font_parser_seek(p: font_parser, pos: number): number {
    console.assert(p.pos >= 0 && p.pos <= p.data.length);
    let old = p.pos;
    p.pos = pos;
    return old;
}

function font_parser_tell(p: font_parser): number { return p.pos; }

function font_parser_get_uint8(p: font_parser): number {
    console.assert(p.pos < p.data.length);
    return p.data[p.pos++];
}

function font_parser_get_uint16(p: font_parser): number {
    return (font_parser_get_uint8(p) << 8 | font_parser_get_uint8(p)) >>> 0;
}

function font_parser_get_uint32(p: font_parser): number {
    return (font_parser_get_uint16(p) << 16 | font_parser_get_uint16(p)) >>> 0;
}

function font_parser_get_int16(p: font_parser): number {
    let r = font_parser_get_uint16(p);
    return r & 0x8000 ? r - 0x10000 : r;
}

function font_parser_get_int32(p: font_parser): number {
    return font_parser_get_uint8(p) << 24 | font_parser_get_uint8(p) << 16 | font_parser_get_uint8(p) << 8 | font_parser_get_uint8(p);
}

function font_parser_get_f_word(p: font_parser): number {
    return font_parser_get_int16(p);
}

function font_parser_get_2_dot_14(p: font_parser): number {
    return font_parser_get_int16(p) / 16384; // 1 << 14
}

function font_parser_get_fixed(p: font_parser): number {
    return font_parser_get_int32(p) / 65536; // 1 << 16
}

function font_parser_get_string(p: font_parser, length: number): string {
    let r = "";
    for (let i = 0; i < length; i++) {
        r += String.fromCharCode(font_parser_get_uint8(p));
    }
    return r;
}

function font_parser_get_date(p: font_parser): Date {
    const mac_time = font_parser_get_uint32(p) * 0x100000000 + font_parser_get_uint32(p);
    const utc_time = mac_time * 1000 + Date.UTC(1904, 0, 1);
    return new Date(utc_time);
}

function font_parser_cal_table_checksum(p: font_parser, offset: number, length: number): number {
    const old = font_parser_seek(p, offset);
    let sum = 0;
    let nlongs = ((length + 3) / 4) | 0;
    while (nlongs-- > 0) {
        sum = (sum + font_parser_get_uint32(p) & 0xffffffff) >>> 0;
    }
    font_parser_seek(p, old);
    return sum;
}

function font_parser_read_offset_tables(p: font_parser): { [key: string]: { checksum: number, offset: number, length: number } } {
    p.scalar_type = font_parser_get_uint32(p);
    const num_tables = font_parser_get_uint16(p);
    p.search_range = font_parser_get_uint16(p); // searchRange
    p.entry_selector = font_parser_get_uint16(p); // entrySelector
    p.range_shift = font_parser_get_uint16(p); // rangeShift

    const tables = {};
    for (let i = 0; i < num_tables; i++) {
        const tag = font_parser_get_string(p, 4);
        const checksum = font_parser_get_uint32(p);
        const offset = font_parser_get_uint32(p);
        const length = font_parser_get_uint32(p);
        tables[tag] = { checksum, offset, length };
        if (tag !== 'head') {
            console.assert(checksum === font_parser_cal_table_checksum(p, offset, length));
        }
    }
    p.tables = tables;
    return tables;
}

function font_parser_read_head_table(p: font_parser) {
    console.assert(p.tables['head']);
    font_parser_seek(p, p.tables['head'].offset);
    const font = p.font;
    font.version = font_parser_get_fixed(p);
    font.font_revision = font_parser_get_fixed(p);
    font.checksum_adjustment = font_parser_get_uint32(p);
    font.magic_number = font_parser_get_uint32(p);
    console.assert(font.magic_number === 0x5f0f3cf5);
    font.flags = font_parser_get_uint16(p);
    font.units_per_em = font_parser_get_uint16(p);
    font.created = font_parser_get_date(p);
    font.modified = font_parser_get_date(p);

    font.x_min = font_parser_get_f_word(p);
    font.y_min = font_parser_get_f_word(p);
    font.x_max = font_parser_get_f_word(p);
    font.y_max = font_parser_get_f_word(p);

    font.mac_style = font_parser_get_uint16(p);
    font.lowest_rec_ppem = font_parser_get_uint16(p);
    font.font_direction_hint = font_parser_get_int16(p);
    font.index_to_loc_format = font_parser_get_int16(p);
    font.glyph_data_format = font_parser_get_int16(p);
}

function font_parser_get_glyph_offset(p: font_parser, index: number): number {
    const table = p.tables['loca'];
    console.assert(table);
    let old: number, offset: number;
    if (p.font.index_to_loc_format === 1) {
        old = font_parser_seek(p, table.offset + index * 4);
        offset = font_parser_get_uint32(p);
    } else {
        old = font_parser_seek(p, table.offset + index * 2);
        offset = font_parser_get_uint16(p) * 2;
    }
    font_parser_seek(p, old);
    return offset + p.tables["glyf"].offset;
}

function font_parser_read_simple_glyph(p: font_parser, g: glyph): void {
    let ON_CURVE = 0x01;
    let X_IS_BYTE = 0x02;
    let Y_IS_BYTE = 0x04;
    let REPEAT = 0x08;
    let X_DELTA = 0x10;
    let Y_DELTA = 0x20;

    g.type = 'simple';
    g.contour_ends = [];
    g.points = [];
    let points = g.points;
    for (let i = 0; i < g.contour_count; i++) {
        g.contour_ends.push(font_parser_get_uint16(p));
    }

    font_parser_seek(p, font_parser_get_uint16(p) + font_parser_tell(p));
    if (g.contour_count === 0) { return; }

    const point_count = Math.max.apply(null, g.contour_ends) + 1;
    const flags: number[] = [];

    for (let i = 0; i < point_count; ++i) {
        let flag = font_parser_get_uint8(p);
        points.push({
            on_curve: (flag & ON_CURVE) > 0,
        } as glyph_point);

        if (flag & REPEAT) {
            let repeat_count = font_parser_get_uint8(p);
            console.assert(repeat_count > 0);
            while (repeat_count--) {
                flags.push(flag);
                points.push({
                    on_curve: (flag & ON_CURVE) > 0,
                } as glyph_point);
            }
        }
    }

    function read_coords(name: string, byte_flag: number, delta_flag: number, min: number, max: number) {
        let value = 0;
        for (let i = 0; i < point_count; ++i) {
            let flag = flags[i];
            if (flag & byte_flag) {
                if (flag & delta_flag) {
                    value += font_parser_get_uint8(p);
                } else {
                    value -= font_parser_get_uint8(p);
                }
            } else if (~flag & delta_flag) {
                value += font_parser_get_int16(p);
            }
            console.assert(value >= min && value <= max);
            points[i][name] = value;
        }
    }

    read_coords('x', X_IS_BYTE, X_DELTA, g.x_min, g.x_max);
    read_coords('y', Y_IS_BYTE, Y_DELTA, g.y_min, g.y_max);
}

function font_parser_read_compound_glyph(p: font_parser, g: glyph): void {

}

function font_parser_read_glyph(p: font_parser, index: number): glyph | null {
    const offset = font_parser_get_glyph_offset(p, index);

    const table = p.tables['glyf'];
    if (offset > table.offset + table.length) { return null; }
    console.assert(offset >= table.offset);
    console.assert(offset < table.offset + table.length);

    const old = font_parser_seek(p, offset);
    const g = {} as glyph;
    g.contour_count = font_parser_get_int16(p);
    console.assert(g.contour_count >= -1);

    g.x_min = font_parser_get_f_word(p);
    g.y_min = font_parser_get_f_word(p);
    g.x_max = font_parser_get_f_word(p);
    g.y_max = font_parser_get_f_word(p);

    if (g.contour_count === -1) {
        font_parser_read_simple_glyph(p, g);
    } else {
        font_parser_read_compound_glyph(p, g);
    }
    font_parser_seek(p, old);
    return g;
}

export async function true_type_font_load(uri: string) {
    const buffer = await fetch_arraybuffer(uri);
    const data = new Uint8Array(buffer);
    const parser = { pos: 0, data, font: {} } as font_parser;

    font_parser_read_offset_tables(parser);
    font_parser_read_head_table(parser);

    return parser;
}