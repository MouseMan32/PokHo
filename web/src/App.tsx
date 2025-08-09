
import React, { useEffect, useState } from 'react'

type SaveItem = { id: string; name: string }

export default function App(){
  const [saves, setSaves] = useState<SaveItem[]>([])
  const [busy, setBusy] = useState(false)

  async function refresh(){
    const r = await fetch('/api/saves')
    const j = await r.json()
    setSaves(j)
  }

  useEffect(()=>{ refresh() },[])

  async function uploadChanged(e: React.ChangeEvent<HTMLInputElement>){
    if(!e.target.files?.length) return
    setBusy(true)
    const form = new FormData()
    Array.from(e.target.files).forEach(f=>form.append('files', f))
    try{
      const r = await fetch('/api/saves', { method: 'POST', body: form })
      if(!r.ok) throw new Error('Upload failed')
      await refresh()
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
      <p>Upload Pokémon save files and list them.</p>

      <label style={{display:'inline-block', padding:'8px 12px', border:'1px solid #ddd', borderRadius:8, cursor:'pointer'}}>
        {busy ? 'Uploading…' : 'Upload Save(s)'}
        <input disabled={busy} onChange={uploadChanged} multiple type="file" style={{display:'none'}}/>
      </label>

      <h2 style={{marginTop:24}}>Saves</h2>
      {!saves.length ? <p>No saves uploaded yet.</p> : (
        <ul>
          {saves.map(s => <li key={s.id}>{s.name}</li>)}
        </ul>
      )}
    </div>
  )
}
