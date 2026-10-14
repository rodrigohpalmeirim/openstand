/** Renders ABC notation as SVG. STUB — owned by the ABC module. */
export function AbcView({ source }: { source: string; transpose: number; width: number }) {
  return <pre className="p-6 text-xs text-black">{source}</pre>
}
