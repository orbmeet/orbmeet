// cf delegates this Container Worker's build to Wrangler. Runtime resources
// live in cloudflare.config.ts; this companion contains only bundler behavior
// that @cloudflare/config does not model.
export default {
	uploadSourceMaps: true,
};
