import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveHermesLaunch } from "./HermesGateway.ts";

describe("resolveHermesLaunch", () => {
  it.effect("drops npm's inherited environment so Hermes' bootstrap resolves its own npm", () =>
    Effect.gen(function* () {
      const launch = resolveHermesLaunch(
        yield* Path.Path,
        { hermesHome: "/srv/hermes", profile: "", pythonPath: "" },
        {
          HOME: "/home/user",
          PATH: "/usr/bin",
          npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
          npm_config_user_agent: "npm/11.11.0",
        },
      );

      expect(Object.keys(launch.env).filter((key) => /^npm_/i.test(key))).toEqual([]);
      expect(launch.env.PATH).toBe("/usr/bin");
      expect(launch.env.HERMES_HOME).toBe("/srv/hermes");
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );
});
