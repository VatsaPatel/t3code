import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as PersonalSettings from "./PersonalSettings.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const TestLayer = PersonalSettings.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "personal-settings-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("updates the sync section while keeping sections other features wrote", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* PersonalSettings.PersonalSettings;
    const filePath = path.join(config.stateDir, "personal-settings.json");

    assert.strictEqual((yield* settings.get).sync.pollSeconds, 20);
    // Another personal feature adds its own section after startup.
    yield* fileSystem.writeFileString(filePath, '{"organizer":{"collapsed":["work"]}}');

    const updated = yield* settings.update({ sync: { hermes: false, pollSeconds: 60 } });
    assert.strictEqual(updated.sync.hermes, false);
    assert.strictEqual(updated.sync.pollSeconds, 60);
    assert.strictEqual(updated.sync.codex, true);
    assert.deepStrictEqual((yield* settings.get).sync, updated.sync);

    const onDisk = decodeJson(yield* fileSystem.readFileString(filePath)) as Record<
      string,
      unknown
    >;
    assert.deepStrictEqual(onDisk.organizer, { collapsed: ["work"] });
    assert.strictEqual((onDisk.sync as Record<string, unknown>).pollSeconds, 60);
  }).pipe(Effect.provide(TestLayer)),
);
