export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-[5px] border border-border bg-background p-4 font-mono text-dim-foreground text-xs leading-6">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}
