// Shiki theme/language grammars are deep-imported by file path (not in the package
// export map, so the ambient declaration applies). Each default-exports a registration.
declare module 'shiki/dist/langs/*' {
	const grammar: unknown
	export default grammar
}
declare module 'shiki/dist/themes/*' {
	const theme: unknown
	export default theme
}
