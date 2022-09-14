export function Later({ title }: { title: string }) {
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <div className="pnl empty">Bu ekran hazırlanıyor.</div>
    </>
  )
}
