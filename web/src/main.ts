import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { installRouter } from './lib/router.svelte'
import { boot } from './lib/stores/app.svelte'

installRouter()
mount(App, { target: document.getElementById('app')! })
void boot()

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
