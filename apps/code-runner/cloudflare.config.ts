// The code-runner Worker's configuration: the sandbox container, its Durable
// Object and the observability it runs with. Reached only through the service
// binding in apps/web, which holds the authorization; the shared secret in
// src/index.ts is the belt to that braces.
//
// `cf dev` runs this Worker through the wrangler delegate (the only impl that
// supports Containers today) — wrangler stays pinned as the implementation
// and wrangler.config.ts supplies its bundler-only source-map setting. Runtime
// resources remain here, and repository commands invoke cf rather than Wrangler.
import {
	bindings,
	defineConfig,
	defineContainer,
	exports,
} from "@cloudflare/config";

// The default scheduling policy, not `durable-object`: `CodeSandbox` drives
// the container through `ctx.container` either way, but only this one carries
// `maxInstances`, and that is the spend ceiling below. With no named images,
// `ctx.container.start()` starts this application's one image.
const container = defineContainer({
	name: "orbmeet-code-runner-codesandbox",
	image: { dockerfile: "./Dockerfile" },
	// standard-1: 1/2 vCPU, 4 GiB, 8 GB disk. The image is ~3 GB, which rules
	// out `basic` (4 GB disk) on space alone, and rustc and javac are the two
	// toolchains that actually want the memory.
	instanceType: "standard-1",
	// The spend ceiling. Each instance is one board's warm container, so this
	// is "how many boards may be running code at once" — raise it deliberately,
	// with the Containers bill in view.
	maxInstances: 8,
});

export default defineConfig({
	worker: {
		name: "orbmeet-code-runner",
		compatibilityDate: "2026-09-11",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "./src/index.ts",
		observability: {
			enabled: true,
			issues: { enabled: true },
			// Unsampled: when a run fails, the log for that exact invocation is
			// the only account of why.
			logs: {
				enabled: true,
				destinations: ["axiom-logs"],
			},
		},
		workersDev: false,
		env: {
			// Shared with the web Worker. A runner without it rejects every request,
			// so make deployment validate it instead of failing only at runtime.
			CODE_RUNNER_SECRET: bindings.secret(),
		},
		exports: {
			// One warm sandbox per whiteboard board; the container field ties the
			// Durable Object's lifecycle to the image defined above. There is no
			// `env` binding for it: src/index.ts reaches it through `ctx.exports`,
			// because a `bindings.durableObject` always names a Worker, and
			// wrangler refuses a container on a Durable Object bound that way.
			CodeSandbox: exports.durableObject({
				storage: "sqlite",
				container,
			}),
		},
	},
	containers: [container],
});
