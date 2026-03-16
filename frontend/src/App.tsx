import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <div>
        <h1>PHW Alpine Events</h1>
        <p>Event management system for Colorado Alpine Chapter</p>
      </div>
    </>
  )
}

export default App