// The bundled code themes, grouped the way the settings select renders them.

export type Option = { value: string; name: string }
export type OptionGroup = { group: string; options: Option[] }

export const opts = (...pairs: [string, string][]): Option[] =>
	pairs.map(([value, name]) => ({ value, name }))

export const CODE_THEMES: OptionGroup[] = [
	{
		group: 'Dark',
		options: opts(
			['material-theme-palenight', 'Palenight'],
			['material-theme-darker', 'Material Darker'],
			['github-dark', 'GitHub Dark'],
			['dracula', 'Dracula'],
			['ayu-dark', 'Ayu Dark'],
			['gruvbox-dark-medium', 'Gruvbox'],
			['everforest-dark', 'Everforest'],
			['dark-plus', 'Dark+ (VS Code)'],
		),
	},
	{
		group: 'Light',
		options: opts(
			['github-light', 'GitHub Light'],
			['one-light', 'One Light'],
			['vitesse-light', 'Vitesse Light'],
			['catppuccin-latte', 'Catppuccin Latte'],
			['everforest-light', 'Everforest Light'],
			['light-plus', 'Light+ (VS Code)'],
		),
	},
	{
		group: 'Diff only',
		options: opts(
			['pierre-dark', 'Pierre Dark'],
			['pierre-dark-soft', 'Pierre Dark Soft'],
			['pierre-light', 'Pierre Light'],
		),
	},
]
