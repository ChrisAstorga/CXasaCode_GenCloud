export function stripTerraformBlocks(text, startPattern) {
  const lines = String(text || "").split(/\r?\n/);
  const output = [];
  let skipping = false;
  let depth = 0;

  for (const line of lines) {
    if (!skipping && startPattern.test(line)) {
      skipping = true;
      depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0) skipping = false;
      continue;
    }
    if (skipping) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0) skipping = false;
      continue;
    }
    output.push(line);
  }
  return output.join("\n").trim();
}

export function stripTerraformSetup(text) {
  return stripTerraformBlocks(
    text,
    /^\s*(terraform|provider\s+["']genesyscloud["'])\s*\{/,
  );
}
