import { mountApp } from './mount'
import './index.css'

const container = document.getElementById('root')
if (container === null) throw new Error('#root not found')

mountApp(container)
