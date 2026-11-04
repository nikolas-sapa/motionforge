import { lstat, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { trackVideo } from "./sam-api.mjs";

const USAGE = `usage: node spike/sam-track.mjs --video PATH --concept "object" --output PATH`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    if (!["--video", "--concept", "--output"].includes(flag)) throw new Error(`unknown option: ${flag}`);
    if (Object.hasOwn(args, flag.slice(2))) throw new Error(`duplicate option: ${flag}`);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    args[flag.slice(2)] = value;
    i += 1;
  }
  return args;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const { video, concept, output } = args;
  if (!video || !concept || !output) {
    console.error(`--video, --concept and --output are required\n${USAGE}`);
    return 2;
  }
  const apiKey = process.env.MODEL_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    console.error("MODEL_API_KEY is not set; export it or provide it via --env-file-if-exists");
    return 2;
  }
  const outputDir = path.dirname(path.resolve(output));
  try {
    const dirStat = await stat(outputDir);
    if (!dirStat.isDirectory()) throw new Error("not a directory");
  } catch {
    console.error(`output directory does not exist: ${outputDir}`);
    return 2;
  }
  try {
    await lstat(output);
    console.error(`refusing to overwrite existing file: ${output}`);
    return 2;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`could not inspect output path: ${output}`);
      return 2;
    }
  }
  let result;
  try {
    result = await trackVideo({ path: video, concept, apiKey });
  } catch (err) {
    console.error(`tracking failed: ${err.message}`);
    return 1;
  }
  try {
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") {
      console.error(`refusing to overwrite existing file: ${output}`);
    } else {
      console.error(`could not write output: ${err.message}`);
    }
    return 1;
  }
  console.log(`tracks: ${result.tracks.length}`);
  console.log(`wrote: ${path.resolve(output)}`);
  return 0;
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedAs === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
