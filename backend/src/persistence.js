import fs from "node:fs/promises";
import path from "node:path";

const DATA_PATH = path.resolve(process.cwd(), "data", "state.json");

async function ensureDirectory() {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
}

export async function loadSnapshot() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { lobbies: [] };
    }

    console.error("Failed to load snapshot:", error);
    return { lobbies: [] };
  }
}

export async function saveSnapshot(snapshot) {
  try {
    await ensureDirectory();
    await fs.writeFile(DATA_PATH, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save snapshot:", error);
  }
}

