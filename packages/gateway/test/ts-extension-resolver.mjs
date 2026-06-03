import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js")
    ) {
      const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
      const parent = new URL(context.parentURL);
      const candidate = new URL(tsSpecifier, parent);

      if (existsSync(candidate)) {
        return nextResolve(tsSpecifier, context);
      }
    }

    return nextResolve(specifier, context);
  }
});
