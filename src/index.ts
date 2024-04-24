import { FontCollection } from "./OpenType";


async function main() {
    const collection = new FontCollection();
    console.log(await collection.add("font/Lato.ttf"));
}

main();