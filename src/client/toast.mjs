import { spawn } from 'node:child_process'

export function notify(event) {
  const text = event.jobId+' · '+event.status
  if (process.platform!=='win32') {console.log(text);return}
  const script = `$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null
$xml=[Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Agent Connecter</text><text/></binding></visual></toast>')
$xml.GetElementsByTagName('text').Item(1).InnerText=$env:CONNECTER_TOAST_TEXT
$toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)`
  return new Promise((resolve,reject) => {
    const child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['ignore','ignore','inherit'],
        env:{...process.env,CONNECTER_TOAST_TEXT:text}})
    child.once('error',reject)
    child.once('exit',code=>code===0?resolve():reject(Error('WinRT toast failed: '+code)))
  })
}
