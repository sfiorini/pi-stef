/**
 * Calculate the new version given a current version and bump type.
 */
export function bumpVersion(version, type) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Invalid version format: "${version}"`);

  let [, major, minor, patch] = match.map(Number);

  switch (type) {
    case "major": major += 1; minor = 0; patch = 0; break;
    case "minor": minor += 1; patch = 0; break;
    case "patch": patch += 1; break;
  }

  return `${major}.${minor}.${patch}`;
}

/**
 * Convert file: protocol dependencies to published version ranges.
 * Uses versionMap (name → newVersion) to resolve cross-package deps.
 */
export function convertFileDependencies(pkg, versionMap) {
  const depFields = ["dependencies", "devDependencies"];
  for (const field of depFields) {
    if (!pkg[field]) continue;
    for (const [depName, depValue] of Object.entries(pkg[field])) {
      if (typeof depValue === "string" && depValue.startsWith("file:")) {
        const newVer = versionMap.get(depName);
        if (newVer) pkg[field][depName] = `^${newVer}`;
      }
    }
  }
}

/**
 * Sanitize a string for safe use in a shell command.
 * Removes only genuinely dangerous characters that could enable shell injection.
 * Preserves spaces, colons, parentheses, and other safe characters.
 */
export function sanitize(str) {
  return str.replace(/[$`;&|\\'"!<>\n\r]/g, "");
}
