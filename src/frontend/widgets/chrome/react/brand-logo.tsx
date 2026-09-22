// The brand block: hamburger + the Syneva mark. The inline SVG keeps the CSS
// filters and exact geometry the favicon and the page share.

import { chromeCtx } from '../context'

import type { ReactElement } from 'react'
// The Syneva mark's blur filters - three regions, one geometry.
const BRAND_FILTERS: { id: string; box: string }[] = [
	{ id: 'hb_f0', box: '0.699 2.647 106.654 106.654' },
	{ id: 'hb_f1', box: '19.301 2.647 106.654 106.654' },
	{ id: 'hb_f2', box: '11.265 0.699 106.654 106.654' },
]

function BrandFilters(): ReactElement {
	return (
		<defs>
			{BRAND_FILTERS.map(({ id, box }) => {
				const [x, y, width, height] = box.split(' ')
				return (
					<filter
						id={id}
						key={id}
						x={x}
						y={y}
						width={width}
						height={height}
						filterUnits="userSpaceOnUse"
						colorInterpolationFilters="sRGB"
					>
						<feFlood floodOpacity="0" result="bg" />
						<feBlend
							mode="normal"
							in="SourceGraphic"
							in2="bg"
							result="shape"
						/>
						<feGaussianBlur stdDeviation="4.6505" />
					</filter>
				)
			})}
		</defs>
	)
}

// The brand block: hamburger + the Syneva mark (the inline SVG keeps the CSS
// filters and exact geometry the favicon and page share).
function BrandLogo(): ReactElement {
	return (
		<>
			<svg
				className="brand-logo"
				aria-hidden="true"
				viewBox="4 -5 120 120"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
			>
				<g filter="url(#hb_f0)">
					<circle
						cx="54.0259"
						cy="55.9741"
						r="44.0259"
						fill="#EB5103"
					/>
				</g>
				<g filter="url(#hb_f1)">
					<circle
						cx="72.6284"
						cy="55.9741"
						r="44.0259"
						fill="#EFCA44"
					/>
				</g>
				<g filter="url(#hb_f2)">
					<circle
						cx="64.5923"
						cy="54.0259"
						r="44.0259"
						fill="#FAF6EA"
					/>
				</g>
				<BrandFilters />
			</svg>
			<span>Syneva</span>
		</>
	)
}

export function BrandBlock(): ReactElement {
	const { S } = chromeCtx()
	return (
		<div className="brand">
			<button
				className="nav-toggle"
				data-tip="Files (⇧B)"
				aria-label="Toggle file tree"
				onClick={() => {
					S.treeDrawerOpen = !S.treeDrawerOpen
				}}
			>
				<svg
					className="ic"
					viewBox="0 0 16 16"
					width="16"
					height="16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
				>
					<path d="M2 4h12M2 8h12M2 12h12" />
				</svg>
			</button>
			<BrandLogo />
		</div>
	)
}
