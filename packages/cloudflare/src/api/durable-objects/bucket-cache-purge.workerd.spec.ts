import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internalPurgeCacheByTags } from "../overrides/internal.js";
import type { BucketCachePurge } from "./bucket-cache-purge.js";

declare global {
	namespace Cloudflare {
		interface Env {
			BUCKET_CACHE_PURGE: DurableObjectNamespace<BucketCachePurge>;
			CACHE_PURGE_ZONE_ID: string;
			CACHE_PURGE_API_TOKEN: string;
		}
	}
}

vi.mock("../overrides/internal.js");

/**
 * Helper to return a fresh DO instance per-test.
 */
function getDOStub() {
	// newUniqueId() - Creates a randomly generated and unique DurableObjectId, which refers to an individual instance of the Durable Object class
	// get(id) - Returns a DurableObjectStub for that ID.
	// The stub is a proxy. The actual Durable Object instance is created on the first request to the stub.
	const id = env.BUCKET_CACHE_PURGE.newUniqueId();
	return env.BUCKET_CACHE_PURGE.get(id);
}

/**
 * Helper to get all tags in the cache_purge table from a stub DO.
 */
async function getTags(stub: DurableObjectStub<BucketCachePurge>) {
	return runInDurableObject(stub, (_instance, state) => {
		return state.storage.sql
			.exec("SELECT tag FROM cache_purge ORDER BY tag")
			.toArray()
			.map((row) => row.tag);
	});
}

describe("BucketCachePurge", () => {
	beforeEach(() => {
		vi.mocked(internalPurgeCacheByTags).mockResolvedValue("purge-success");
	});

	it("should create the cache_purge table on construction", async () => {
		const stub = getDOStub();

		// Access the DO so it gets constructed, then verify the table exists
		const tables = await runInDurableObject(stub, (_instance, state) => {
			return state.storage.sql
				.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='cache_purge'")
				.toArray();
		});

		expect(tables).toStrictEqual([{ name: "cache_purge" }]);
	});

	describe("purgeCacheByTags", () => {
		it("should insert tags into the sql table", async () => {
			const stub = getDOStub();

			await stub.purgeCacheByTags(["tag1", "tag2"]);

			const tags = await getTags(stub);

			expect(tags).toEqual(["tag1", "tag2"]);
		});

		it("should set an alarm if no alarm is set", async () => {
			const stub = getDOStub();

			await stub.purgeCacheByTags(["tag"]);

			const alarm = await runInDurableObject(stub, async (_instance, state) => {
				return state.storage.getAlarm();
			});

			expect(alarm).not.toBeNull();
		});

		it("should not set an alarm if one is already set", async () => {
			const stub = getDOStub();

			// Manually set an alarm via runInDurableObject
			const originalAlarm = await runInDurableObject(stub, async (_instance, state) => {
				const alarmTime = Date.now() + 60_000;
				state.storage.setAlarm(alarmTime);
				return alarmTime;
			});

			await stub.purgeCacheByTags(["tag"]);

			const currentAlarm = await runInDurableObject(stub, async (_instance, state) => {
				return state.storage.getAlarm();
			});

			expect(currentAlarm).toBe(originalAlarm);
		});
	});

	describe("alarm", () => {
		it("should purge cache by tags and delete them from the sql table", async () => {
			const stub = getDOStub();

			await stub.purgeCacheByTags(["tag1", "tag2"]);

			// Verify tags exist before alarm
			const tagsBefore = await getTags(stub);
			expect(tagsBefore).toEqual(["tag1", "tag2"]);

			// Trigger the alarm
			const alarmRan = await runDurableObjectAlarm(stub);
			expect(alarmRan).toBe(true);

			// Verify tags are deleted after alarm
			const tagsAfter = await getTags(stub);
			expect(tagsAfter).toEqual([]);
		});

		it("should not purge cache if no tags are found", async () => {
			const stub = getDOStub();

			// Set an alarm manually so runDurableObjectAlarm runs the handler
			await runInDurableObject(stub, async (_instance, state) => {
				state.storage.setAlarm(Date.now() + 1000);
			});

			const alarmRan = await runDurableObjectAlarm(stub);
			expect(alarmRan).toBe(true);

			// internalPurgeCacheByTags should NOT have been called
			expect(internalPurgeCacheByTags).not.toHaveBeenCalled();
		});

		it("should call internalPurgeCacheByTags with the correct tags", async () => {
			const stub = getDOStub();

			await stub.purgeCacheByTags(["tag1", "tag2"]);

			await runDurableObjectAlarm(stub);

			expect(internalPurgeCacheByTags).toHaveBeenCalledWith(expect.anything(), ["tag1", "tag2"]);
			expect(internalPurgeCacheByTags).toHaveBeenCalledOnce();
		});

		it("should continue until all tags are purged", async () => {
			const stub = getDOStub();

			// Insert 150 tags — more than MAX_NUMBER_OF_TAGS_PER_PURGE (100)
			const tags = Array.from({ length: 150 }, (_, i) => `tag${String(i).padStart(3, "0")}`);
			await stub.purgeCacheByTags(tags);

			// Verify all 150 tags are stored
			const tagsBefore = await getTags(stub);
			expect(tagsBefore).toHaveLength(150);

			await runDurableObjectAlarm(stub);

			// Two batches: first 100 tags, then the remaining 50
			expect(internalPurgeCacheByTags).toHaveBeenCalledTimes(2);

			// Verify all tags are deleted
			const tagsAfter = await getTags(stub);
			expect(tagsAfter).toEqual([]);
		});

		it("should throw on rate-limit and keep tags in the table", async () => {
			vi.mocked(internalPurgeCacheByTags).mockResolvedValue("rate-limit-exceeded");

			const stub = getDOStub();

			await stub.purgeCacheByTags(["tag1", "tag2"]);

			// The alarm handler throws on rate-limit
			await expect(runDurableObjectAlarm(stub)).rejects.toThrow("Rate limit exceeded");

			// Tags should still be in the table because deletion is skipped on rate-limit
			const tags = await getTags(stub);
			expect(tags).toEqual(["tag1", "tag2"]);
		});
	});
});
