import React, { useEffect, useState } from 'react'

type SaveItem = { id: string; name: string }
type Validation = {
  filename: string
  size: number
  sha256: string
  detection: { kind: string; game: string; generation: number | string; confidence: number; notes?: string }
}

export default function App(){
  const [saves, setSaves] = useState<SaveItem[]>([])
  const [validations, setValidations] = useState<Record<string, Validation>>({})
  const [busy, setBusy] = useState(false)

  async function refresh(){
    const r = await fetch('/api/saves')
    const j = await r.json()
    setSaves(j)
  }
  useEffect(()=>{ refresh() },[])

  async function setOverride(id: string, game: string, generation = "6") {
    const r = await fetch('/api/saves/override', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ id, game, generation })
    });
    if (!r.ok) throw new Error('Failed to set override');
 }


  async function validateById(id: string){
    const r = await fetch('/api/saves/validate', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ id })
    })
    if(!r.ok) throw new Error('Validate failed')
    const val: Validation = await r.json()
    setValidations(prev => ({ ...prev, [id]: val }))
  }

  async function uploadChanged(e: React.ChangeEvent<HTMLInputElement>){
    if(!e.target.files?.length) return
    setBusy(true)
    const form = new FormData()
    Array.from(e.target.files).forEach(f=>form.append('files', f))
    try{
      const r = await fetch('/api/saves', { method: 'POST', body: form })
      if(!r.ok) throw new Error('Upload failed')
      const { uploaded } = await r.json()
      await refresh()
      // Kick off validations
      for (const f of uploaded) await validateById(f.id)
      alert('Upload complete')
    }catch(err:any){
      alert(err?.message || 'Upload error')
    }finally{
      setBusy(false)
      e.target.value = ''
    }
  }

  return (
    <div style={{fontFamily:'system-ui, sans-serif', padding: 24}}>
      <h1>OpenHome Web (MVP)</h1>
      <p>Uploads now get validated. Unknown saves can be manually assigned to a game.</p>

      <label style={{display:'inline-block', padding:'8px 12px', border:'1px solid #ddd', borderRadius:8, cursor:'pointer'}}>
        {busy ? 'Uploading…' : 'Upload Save(s)'}
        <input disabled={busy} onChange={uploadChanged} multiple type="file" style={{display:'none'}}/>
      </label>

      <h2 style={{marginTop:24}}>Saves</h2>
      {!saves.length ? <p>No saves uploaded yet.</p> : (
        <ul>
          {saves.map(s => {
            const v = validations[s.id]
            return (
              <li key={s.id} style={{marginBottom:12}}>
                <div><strong>{s.name}</strong></div>
                <div style={{fontSize:13, opacity:.8}}>
                  {v ? (
                    <>
                      <div>Detected: {v.detection.kind} → {v.detection.game} (gen {String(v.detection.generation)}), confidence {Math.round(v.detection.confidence*100)}%</div>
                      <div>{v.detection.notes}</div>
                      <div>Size: {v.size.toLocaleString()} bytes</div>
                      <div>SHA-256: <code>{v.sha256.slice(0,16)}…</code></div>
                      <button
                        style={{marginTop:6, padding:'4px 8px'}}
                        onClick={()=>window.open(`/api/boxes/${encodeURIComponent(s.id)}`, '_blank')}
                      >
                        View Boxes (stub)
                      </button>
                    </>
                  ) : (
                    <button
                      style={{padding:'4px 8px'}}
                      onClick={()=>validateById(s.id)}
                    >
                      Validate
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
