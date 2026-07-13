import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function trustedRoot() {
  if (platform() === "linux") return "/opt/plasius/webgpu-fleet";
  if (platform() === "darwin") return "/Library/Application Support/Plasius/WebGPUFleet";
  if (platform() === "win32") return "C:\\ProgramData\\Plasius\\WebGPUFleet";
  throw new TypeError("Trusted physical fleet adapters are unsupported on this controller platform.");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSelfContainedModule(source) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  if (text.includes("`")) {
    throw new TypeError("Trusted fleet adapter must be self-contained without template literals.");
  }
  let stripped = "";
  let state = "code";
  for (let index = 0; index < text.length; index += 1) {
    const value = text[index];
    const next = text[index + 1];
    if (state === "code") {
      if (value === "'") { state = "single"; stripped += " "; }
      else if (value === '"') { state = "double"; stripped += " "; }
      else if (value === "/" && next === "/") { state = "line"; stripped += "  "; index += 1; }
      else if (value === "/" && next === "*") { state = "block"; stripped += "  "; index += 1; }
      else stripped += value;
    } else if (state === "line") {
      if (value === "\n") { state = "code"; stripped += "\n"; } else stripped += " ";
    } else if (state === "block") {
      if (value === "*" && next === "/") { state = "code"; stripped += "  "; index += 1; }
      else stripped += value === "\n" ? "\n" : " ";
    } else if (value === "\\") {
      stripped += "  ";
      index += 1;
    } else if ((state === "single" && value === "'") || (state === "double" && value === '"')) {
      state = "code";
      stripped += " ";
    } else {
      stripped += value === "\n" ? "\n" : " ";
    }
  }
  if (state !== "code" && state !== "line") {
    throw new TypeError("Trusted fleet adapter source is lexically incomplete.");
  }
  if (/(?:^|[^A-Za-z0-9_$])(?:import|require|createRequire|eval|Function)(?:[^A-Za-z0-9_$]|$)/u.test(stripped)) {
    throw new TypeError("Trusted fleet adapter must not perform transitive code loading.");
  }
}

const configuredUrl = process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_URL?.trim() || "";
const expectedSha256 = process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_SHA256?.trim() || "";
if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
  throw new TypeError("Trusted fleet adapter digest is not configured as lowercase SHA-256.");
}

let configuredPath;
try {
  const url = new URL(configuredUrl);
  if (url.protocol !== "file:") throw new TypeError("not file");
  configuredPath = resolve(fileURLToPath(url));
} catch (cause) {
  throw new TypeError("Trusted fleet adapter URL must be an absolute file URL.", { cause });
}

const root = await realpath(resolve(trustedRoot()));
const stats = await lstat(configuredPath);
if (!stats.isFile() || stats.isSymbolicLink() || !configuredPath.endsWith(".mjs")) {
  throw new TypeError("Trusted fleet adapter must be a regular non-linked .mjs file.");
}
const modulePath = await realpath(configuredPath);
const child = relative(root, modulePath);
if (!child || child.startsWith("..") || isAbsolute(child)) {
  throw new TypeError("Trusted fleet adapter is outside its fixed runner-owned root.");
}

const moduleBytes = new Uint8Array(await readFile(modulePath));
assertSelfContainedModule(moduleBytes);
const actualSha256 = sha256(
  `plasius.trusted-fleet-adapter-single-file/v1\n${sha256(moduleBytes)}`,
);
if (actualSha256 !== expectedSha256) {
  throw new TypeError("Trusted fleet adapter bytes differ from runner-owned calibration.");
}

// Execute the already-verified immutable byte snapshot, not the filesystem path.
await import(`data:text/javascript;base64,${Buffer.from(moduleBytes).toString("base64")}`);
