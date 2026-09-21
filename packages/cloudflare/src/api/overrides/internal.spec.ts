import { describe, expect, it, vi } from "vitest";

import { internalPurgeCacheByTags } from "./internal.js";

// Mock dependencies
vi.mock("@opennextjs/aws/adapters/logger.js", () => ({
	error: vi.fn(),
}));

const successBody = () => {
	return new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 });
};
const failBody = () => {
	return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "fail" }] }), {
		status: 200,
	});
};
const rateLimitBody = () => {
	return new Response(null, { status: 429 });
};

describe("internalPurgeCacheByTags", () => {
	it.each([
		{ scenario: "no env vars set", env: {} },
		{ scenario: "only CACHE_PURGE_ZONE_ID set", env: { CACHE_PURGE_ZONE_ID: "zone-a" } },
		{ scenario: "only CACHE_PURGE_API_TOKEN set", env: { CACHE_PURGE_API_TOKEN: "token" } },
	])("should return missing-credentials when $scenario", async ({ env }) => {
		const result = await internalPurgeCacheByTags(env as CloudflareEnv, ["tag1"]);
		expect(result).toBe("missing-credentials");
	});

	it("should purge a single zone via CACHE_PURGE_ZONE_ID", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(successBody());

		const env = {
			CACHE_PURGE_ZONE_ID: "zone-a",
			CACHE_PURGE_API_TOKEN: "token",
		} as CloudflareEnv;

		const result = await internalPurgeCacheByTags(env, ["tag1"]);

		expect(result).toBe("purge-success");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.cloudflare.com/client/v4/zones/zone-a/purge_cache",
			expect.objectContaining({ method: "POST" })
		);
	});

	it("should purge multiple zones via comma-separated CACHE_PURGE_ZONE_ID", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(successBody()));

		const env = {
			CACHE_PURGE_ZONE_ID: "zone-a, zone-b, zone-c",
			CACHE_PURGE_API_TOKEN: "token",
		} as CloudflareEnv;

		const result = await internalPurgeCacheByTags(env, ["tag1"]);

		expect(result).toBe("purge-success");
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.cloudflare.com/client/v4/zones/zone-a/purge_cache",
			expect.anything()
		);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.cloudflare.com/client/v4/zones/zone-b/purge_cache",
			expect.anything()
		);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.cloudflare.com/client/v4/zones/zone-c/purge_cache",
			expect.anything()
		);
	});

	it("should de-duplicate zone IDs in CACHE_PURGE_ZONE_ID", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(successBody()));

		const env = {
			CACHE_PURGE_ZONE_ID: "zone-a, zone-b, zone-a",
			CACHE_PURGE_API_TOKEN: "token",
		} as CloudflareEnv;

		const result = await internalPurgeCacheByTags(env, ["tag1"]);

		expect(result).toBe("purge-success");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("should return rate-limit-exceeded when any zone is rate-limited", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(successBody())
			.mockResolvedValueOnce(rateLimitBody());

		const env = {
			CACHE_PURGE_ZONE_ID: "zone-a, zone-b",
			CACHE_PURGE_API_TOKEN: "token",
		} as CloudflareEnv;

		const result = await internalPurgeCacheByTags(env, ["tag1"]);

		expect(result).toBe("rate-limit-exceeded");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("should return purge-failed when any zone reports failure", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(successBody())
			.mockResolvedValueOnce(failBody());

		const env = {
			CACHE_PURGE_ZONE_ID: "zone-a, zone-b",
			CACHE_PURGE_API_TOKEN: "token",
		} as CloudflareEnv;

		const result = await internalPurgeCacheByTags(env, ["tag1"]);

		expect(result).toBe("purge-failed");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("should pass the correct tags in the request body", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(successBody());

		const env = {
			CACHE_PURGE_ZONE_ID: "zone-a",
			CACHE_PURGE_API_TOKEN: "my-token",
		} as CloudflareEnv;

		await internalPurgeCacheByTags(env, ["tag1", "tag2"]);

		expect(fetchSpy).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/zones/zone-a/purge_cache", {
			body: '{"tags":["tag1","tag2"]}',
			method: "POST",
			headers: {
				Authorization: "Bearer my-token",
				"Content-Type": "application/json",
			},
		});
	});

	it("should handle empty entries in CACHE_PURGE_ZONE_ID (trailing comma)", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(successBody()));

		const env = {
			CACHE_PURGE_ZONE_ID: "zone-a,,zone-b,",
			CACHE_PURGE_API_TOKEN: "token",
		} as CloudflareEnv;

		const result = await internalPurgeCacheByTags(env, ["tag1"]);

		expect(result).toBe("purge-success");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("should return purge-failed when fetch throws", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

		const env = {
			CACHE_PURGE_ZONE_ID: "zone-a",
			CACHE_PURGE_API_TOKEN: "token",
		} as CloudflareEnv;

		const result = await internalPurgeCacheByTags(env, ["tag1"]);

		expect(result).toBe("purge-failed");
	});

	it("should prioritise rate-limit-exceeded over purge-failed", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(failBody()).mockResolvedValueOnce(rateLimitBody());

		const env = {
			CACHE_PURGE_ZONE_ID: "zone-a, zone-b",
			CACHE_PURGE_API_TOKEN: "token",
		} as CloudflareEnv;

		const result = await internalPurgeCacheByTags(env, ["tag1"]);

		expect(result).toBe("rate-limit-exceeded");
	});
});
