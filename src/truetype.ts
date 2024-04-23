// ref: https://tchayen.github.io/posts/ttf-file-parsing 

async function fetch_arraybuffer(uri: string): Promise<ArrayBuffer> {
    return await (await fetch(uri)).arrayBuffer();
}

interface font_parser {
    position: number;
    data: Uint8Array;
    get_uint8(): number;
    get_uint16(): number;
    get_uint32(): number;
    get_int16(): number;
    get_int32(): number;
    get_f_word(): number;
    get_uf_word(): number;
    get_offset16(): number;
    get_offset32(): number;
    get_f_to_dot14(): number;
    get_fixed(): number;
    get_string(length: number): string;
    get_date(): Date;
    get_position(): number;
    set_position(target: number): void;
}

function font_parser_get_uint8(parser: font_parser): number {
    return parser.data[parser.position++];
}

function font_parser_get_uint16(parser: font_parser): number {
    const value = (parser.data[parser.position] << 8) | parser.data[parser.position + 1];
    parser.position += 2;
    return value;
}

function font_parser_get_uint32(parser: font_parser): number {
    const value = (parser.data[parser.position] << 24) | (parser.data[parser.position + 1] << 16) | (parser.data[parser.position + 2] << 8) | parser.data[parser.position + 3];
    parser.position += 4;
    return value;
}

function font_parser_get_int16(parser: font_parser): number {
    const value = (parser.data[parser.position] << 8) | parser.data[parser.position + 1];
    parser.position += 2;
    return value;
}

function font_parser_get_int32(parser: font_parser): number {
    const value = (parser.data[parser.position] << 24) | (parser.data[parser.position + 1] << 16) | (parser.data[parser.position + 2] << 8) | parser.data[parser.position + 3];
    parser.position += 4;
    return value;
}

function font_parser_get_f_word(parser: font_parser): number {
    return font_parser_get_int16(parser);
}

function font_parser_get_uf_word(parser: font_parser): number {
    return font_parser_get_uint16(parser);
}

function font_parser_get_offset16(parser: font_parser): number {
    return font_parser_get_uint16(parser);
}

function font_parser_get_offset32(parser: font_parser): number {
    return font_parser_get_uint32(parser);
}

function font_parser_get_f_to_dot14(parser: font_parser): number {
    return font_parser_get_int16(parser);
}

function font_parser_get_fixed(parser: font_parser): number {
    return font_parser_get_int32(parser);
}

function font_parser_get_string(parser: font_parser, length: number): string {
    const value = String.fromCharCode(...parser.data.slice(parser.position, parser.position + length));
    parser.position += length;
    return value;
}

function font_parser_set_position(parser: font_parser, target: number): void {
    parser.position = target;
}

function font_parser_get_date(parser: font_parser): Date {
    const mac_time = font_parser_get_uint32(parser);
    return new Date((mac_time * 0x100000000) / 1000);
}

function font_parser_get_position(parser: font_parser): number {
    return parser.position;
}

export async function true_type_font_load(uri: string) {
    const buffer = await fetch_arraybuffer(uri);
    const data = new Uint8Array(buffer);
    const parser = { position: 0, data } as font_parser;

    const scalar_type = font_parser_get_uint32(parser);
    const num_tables = font_parser_get_uint16(parser);
    const search_range = font_parser_get_uint16(parser); // searchRange
    const entry_selector = font_parser_get_uint16(parser); // entrySelector
    const range_shift = font_parser_get_uint16(parser); // rangeShift

    console.log({ scalar_type, num_tables, search_range, entry_selector, range_shift });

    const tables = {};
    const tags: string[] = [];
    for (let i = 0; i < num_tables; i++) {
        const tag = font_parser_get_string(parser, 4);
        const checksum = font_parser_get_uint32(parser);
        const offset = font_parser_get_uint32(parser);
        const length = font_parser_get_uint32(parser);
        tables[tag] = { checksum, offset, length };
        tags.push(tag);
    }
    console.log(tags.join(", "));
    console.log(tables);

    const head = {};
    head['major'] = font_parser_get_uint16(parser);
    head['minor'] = font_parser_get_uint16(parser);
    head['font_revision'] = font_parser_get_fixed(parser);
    head['checksum_adjustment'] = font_parser_get_uint32(parser);
    head['magic_number'] = font_parser_get_uint32(parser);
    head['flags'] = font_parser_get_uint16(parser);
    head['units_per_em'] = font_parser_get_uint16(parser);
    head['created'] = font_parser_get_date(parser);
    head['modified'] = font_parser_get_date(parser);
    head['x_min'] = font_parser_get_f_word(parser);
    head['y_min'] = font_parser_get_f_word(parser);
    head['x_max'] = font_parser_get_f_word(parser);
    head['y_max'] = font_parser_get_f_word(parser);
    head['mac_style'] = font_parser_get_uint16(parser);
    head['lowest_rec_ppem'] = font_parser_get_uint16(parser);
    head['font_direction_hint'] = font_parser_get_int16(parser);
    head['index_to_loc_format'] = font_parser_get_int16(parser);
    head['glyph_data_format'] = font_parser_get_int16(parser);
    console.log(head);

    const maxp = {};
    maxp['version'] = font_parser_get_fixed(parser);
    maxp['num_glyphs'] = font_parser_get_uint16(parser);
    maxp['max_points'] = font_parser_get_uint16(parser);
    maxp['max_contours'] = font_parser_get_uint16(parser);
    maxp['max_composite_points'] = font_parser_get_uint16(parser);
    maxp['max_composite_contours'] = font_parser_get_uint16(parser);
    maxp['max_zones'] = font_parser_get_uint16(parser);
    maxp['max_twilight_points'] = font_parser_get_uint16(parser);
    maxp['max_storage'] = font_parser_get_uint16(parser);
    maxp['max_function_defs'] = font_parser_get_uint16(parser);
    maxp['max_instruction_defs'] = font_parser_get_uint16(parser);
    maxp['max_stack_elements'] = font_parser_get_uint16(parser);
    maxp['max_size_of_instructions'] = font_parser_get_uint16(parser);
    maxp['max_component_elements'] = font_parser_get_uint16(parser);
    maxp['max_component_depth'] = font_parser_get_uint16(parser);
    console.log(maxp);

    const hhea = {};
    hhea['version'] = font_parser_get_fixed(parser);
    hhea['ascender'] = font_parser_get_f_word(parser);
    hhea['descender'] = font_parser_get_f_word(parser);
    hhea['line_gap'] = font_parser_get_f_word(parser);
    hhea['advance_width_max'] = font_parser_get_uf_word(parser);
    hhea['min_left_side_bearing'] = font_parser_get_f_word(parser);
    hhea['min_right_side_bearing'] = font_parser_get_f_word(parser);
    hhea['x_max_extent'] = font_parser_get_f_word(parser);
    hhea['caret_slope_rise'] = font_parser_get_int16(parser);
    hhea['caret_slope_run'] = font_parser_get_int16(parser);
    hhea['caret_offset'] = font_parser_get_f_word(parser);

    // reserved
    font_parser_get_int16(parser);
    font_parser_get_int16(parser);
    font_parser_get_int16(parser);
    font_parser_get_int16(parser);

    hhea['metric_data_format'] = font_parser_get_int16(parser);
    hhea['number_of_hmetrics'] = font_parser_get_uint16(parser);

    // hmtx
    const hmtx = {};
    for (let i = 0, l = hhea['number_of_hmetrics']; i < l; i++) {
        hmtx[i] = {
            advance_width: font_parser_get_uint16(parser),
            left_side_bearing: font_parser_get_int16(parser),
        };
    }

    const left_side_bearings: number[] = [];
    for (let i = hhea['number_of_hmetrics'], l = maxp['num_glyphs']; i < l; i++) {
        left_side_bearings.push(font_parser_get_f_word(parser));
    }

    const getter = head['index_to_loc_format'] === 0 ? font_parser_get_offset16 : font_parser_get_offset32;
    const loca = {};
    for (let i = 0, l = maxp['num_glyphs']; i < l; i++) {
        loca[i] = getter(parser);
    }

    const glfy: any[] = [];
    const multiplier = head['index_to_loc_format'] === 0 ? 2 : 1
    for (let i = 0, l = maxp['num_glyphs']; i < l; i++) {
        const offset = loca[i] * multiplier;
        if (offset === loca[i + 1]) {
            continue;
        }
        font_parser_set_position(parser, offset);
        const number_of_contours = font_parser_get_int16(parser);
        glfy.push({ number_of_contours });
    }
}