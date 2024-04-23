import { true_type_font_load } from "./truetype";

async function main() {

    console.log(await true_type_font_load("font/Lato.ttf"));
}

main();