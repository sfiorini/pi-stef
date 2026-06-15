export function stripJsonc(input: string): string {
  let output = "";
  let inString = false;
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        inString = false;
        quote = undefined;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      if (i < input.length) output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length) {
        if (input[i] === "\n") output += "\n";
        if (input[i] === "*" && input[i + 1] === "/") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    output += char;
  }

  return output;
}
