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
 * NOTE: Currently a no-op — CI handles conversion before publish.
 */
export function convertFileDependencies(pkg, _versionMap) {
  // Intentionally left as no-op; CI converts file: deps before publishing
}

/**
 * Sanitize a string for safe use in a shell command.
 * Removes only genuinely dangerous characters that could enable shell injection.
 * Preserves spaces, colons, parentheses, and other safe characters.
 */
export function sanitize(str) {
  return str.replace(/[$`;&|\\'"!<>\n\r]/g, "");
}
