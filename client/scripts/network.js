window.URL = window.URL || window.webkitURL
window.isRtcSupported = !!(
  window.RTCPeerConnection ||
  window.mozRTCPeerConnection ||
  window.webkitRTCPeerConnection
)

class ServerConnection {
  constructor() {
    this.register()
  }

  async register() {
    this.peers = []
    this.name = {}
    await this._update(true)
    this.updateInterval = setInterval(() => this._update(), 5000)
    Events.on('beforeunload', () => this._onBeforeUnload())
  }

  async _update(initial = false) {
    const response = await fetch(this._endpoint('/update'), { method: 'GET' })
    const { id, name, peers, signals } = await response.json()

    this.id = id
    if (name.displayName !== this.name.displayName && initial) {
      this.name = name
      Events.fire('display-name', name)
    }

    const newPeers = peers.filter(
      (peer) => !this.peers.find((oldPeer) => oldPeer.id === peer.id)
    )
    const leftPeers = this.peers.filter(
      (oldPeer) => !peers.find((peer) => peer.id === oldPeer.id)
    )
    for (const newPeer of newPeers) {
      Events.fire('peer-joined', newPeer)
    }
    for (const leftPeer of leftPeers) {
      Events.fire('peer-left', leftPeer.id)
    }
    this.peers = peers

    for (const signal of signals) {
      Events.fire('signal', signal)
    }
  }

  _onBeforeUnload() {
    fetch(this._endpoint('/update'), { method: 'DELETE', keepalive: true })
    clearInterval(this.updateInterval)
  }

  async send(message) {
    await fetch(this._endpoint('/signals'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    })
  }

  _endpoint(path = '/') {
    const url = `${window.location.origin}/server${path}`
    return url
  }
}

class Peer {
  constructor(serverConnection, peerId) {
    this._server = serverConnection
    this._peerId = peerId
    this._filesQueue = []
    this._busy = false
  }

  sendJSON(message) {
    this._send(JSON.stringify(message))
  }

  sendFiles(files) {
    for (let i = 0; i < files.length; i++) {
      this._filesQueue.push(files[i])
    }
    if (this._busy) return
    this._dequeueFile()
  }

  _dequeueFile() {
    if (!this._filesQueue.length) return
    this._busy = true
    const file = this._filesQueue.shift()
    this._sendFile(file)
  }

  _sendFile(file) {
    this.sendJSON({
      type: 'header',
      name: file.name,
      mime: file.type,
      size: file.size,
    })
    this._chunker = new FileChunker(
      file,
      (chunk) => this._send(chunk),
      (offset) => this._onPartitionEnd(offset)
    )
    this._chunker.nextPartition()
  }

  _onPartitionEnd(offset) {
    this.sendJSON({ type: 'partition', offset: offset })
  }

  _onReceivedPartitionEnd(offset) {
    this.sendJSON({ type: 'partition-received', offset: offset })
  }

  _sendNextPartition() {
    if (!this._chunker || this._chunker.isFileEnd()) return
    this._chunker.nextPartition()
  }

  _sendProgress(progress) {
    this.sendJSON({ type: 'progress', progress: progress })
  }

  _onMessage(message) {
    if (typeof message !== 'string') {
      this._onChunkReceived(message)
      return
    }
    message = JSON.parse(message)
    switch (message.type) {
      case 'header':
        this._onFileHeader(message)
        break
      case 'partition':
        this._onReceivedPartitionEnd(message)
        break
      case 'partition-received':
        this._sendNextPartition()
        break
      case 'progress':
        this._onDownloadProgress(message.progress)
        break
      case 'transfer-complete':
        this._onTransferCompleted()
        break
      case 'text':
        this._onTextReceived(message)
        break
    }
  }

  _onFileHeader(header) {
    this._lastProgress = 0
    this._digester = new FileDigester(
      {
        name: header.name,
        mime: header.mime,
        size: header.size,
      },
      (file) => this._onFileReceived(file)
    )
  }

  _onChunkReceived(chunk) {
    if (!chunk.byteLength) return

    this._digester.unchunk(chunk)
    const progress = this._digester.progress
    this._onDownloadProgress(progress)

    // occasionally notify sender about our progress
    if (progress - this._lastProgress < 0.01) return
    this._lastProgress = progress
    this._sendProgress(progress)
  }

  _onDownloadProgress(progress) {
    Events.fire('file-progress', { sender: this._peerId, progress: progress })
  }

  _onFileReceived(proxyFile) {
    Events.fire('file-received', proxyFile)
    this.sendJSON({ type: 'transfer-complete' })
  }

  _onTransferCompleted() {
    this._onDownloadProgress(1)
    this._reader = null
    this._busy = false
    this._dequeueFile()
    Events.fire('notify-user', 'File transfer completed.')
  }

  sendText(text) {
    const unescaped = btoa(unescape(encodeURIComponent(text)))
    this.sendJSON({ type: 'text', text: unescaped })
  }

  _onTextReceived(message) {
    const escaped = decodeURIComponent(escape(atob(message.text)))
    Events.fire('text-received', { text: escaped, sender: this._peerId })
  }
}

class RTCPeer extends Peer {
  constructor(serverConnection, peerId) {
    super(serverConnection, peerId)
    if (!peerId) return // we will listen for a caller
    ;(async () => {
      this._connect(peerId, await this._determineCaller())
    })()
  }

  async _determineCaller() {
    const sorted = [this._server.id, this._peerId].sort()
    const rawSorted = new TextEncoder().encode(sorted.join(''))
    const hashBuffer = await crypto.subtle.digest('SHA-256', rawSorted)
    const dataView = new DataView(hashBuffer)
    const leastSignificantBit = dataView.getUint8(0) & 0b00000001
    const responsibleId = sorted[leastSignificantBit]
    return responsibleId === this._server.id
  }

  _connect(peerId, isCaller) {
    if (!this._conn) this._openConnection(peerId, isCaller)

    if (isCaller) {
      this._openChannel()
    } else {
      this._conn.ondatachannel = (e) => this._onChannelOpened(e)
    }
  }

  _openConnection(peerId, isCaller) {
    this._isCaller = isCaller
    this._peerId = peerId
    this._conn = new RTCPeerConnection(RTCPeer.config)
    this._conn.onicecandidate = (e) => this._onIceCandidate(e)
    this._conn.onconnectionstatechange = (e) => this._onConnectionStateChange(e)
    this._conn.oniceconnectionstatechange = (e) =>
      this._onIceConnectionStateChange(e)
  }

  _openChannel() {
    const channel = this._conn.createDataChannel('data-channel', {
      ordered: true,
      reliable: true, // Obsolete. See https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/reliable
    })
    channel.onopen = (e) => this._onChannelOpened(e)
    this._conn
      .createOffer()
      .then((d) => this._onDescription(d))
      .catch((e) => this._onError(e))
  }

  _onDescription(description) {
    // description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
    this._conn
      .setLocalDescription(description)
      .then((_) => this._sendSignal({ sdp: description }))
      .catch((e) => this._onError(e))
  }

  _onIceCandidate(event) {
    if (!event.candidate) return
    this._sendSignal({ ice: event.candidate })
  }

  onServerMessage(message) {
    if (!this._conn) this._connect(message.sender, false)

    if (message.sdp) {
      this._conn
        .setRemoteDescription(new RTCSessionDescription(message.sdp))
        .then((_) => {
          if (message.sdp.type === 'offer') {
            return this._conn.createAnswer().then((d) => this._onDescription(d))
          }
        })
        .catch((e) => this._onError(e))
    } else if (message.ice) {
      this._conn.addIceCandidate(new RTCIceCandidate(message.ice))
    }
  }

  _onChannelOpened(event) {
    const channel = event.channel || event.target
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (e) => this._onMessage(e.data)
    channel.onclose = (e) => this._onChannelClosed()
    this._channel = channel
  }

  _onChannelClosed() {
    if (!this.isCaller) return
    this._connect(this._peerId, true) // reopen the channel
  }

  _onConnectionStateChange(e) {
    switch (this._conn.connectionState) {
      case 'disconnected':
        this._onChannelClosed()
        break
      case 'failed':
        this._conn = null
        this._onChannelClosed()
        break
    }
  }

  _onIceConnectionStateChange() {
    switch (this._conn.iceConnectionState) {
      case 'failed':
        console.error('ICE Gathering failed')
        break
      default:
        break
    }
  }

  _onError(error) {
    console.error(error)
  }

  _send(message) {
    if (!this._channel) return this.refresh()
    this._channel.send(message)
  }

  _sendSignal(signal) {
    signal.type = 'signal'
    signal.to = this._peerId
    this._server.send(signal)
  }

  refresh() {
    // check if channel is open. otherwise create one
    if (this._isConnected() || this._isConnecting()) return
    this._connect(this._peerId, this._isCaller)
  }

  _isConnected() {
    return this._channel && this._channel.readyState === 'open'
  }

  _isConnecting() {
    return this._channel && this._channel.readyState === 'connecting'
  }
}

class PeersManager {
  constructor(serverConnection) {
    this.peers = {}
    this._server = serverConnection
    Events.on('signal', (e) => this._onMessage(e.detail))
    Events.on('peers', (e) => this._onPeers(e.detail))
    Events.on('peer-joined', (e) => this._onPeer(e.detail))
    Events.on('files-selected', (e) => this._onFilesSelected(e.detail))
    Events.on('send-text', (e) => this._onSendText(e.detail))
    Events.on('peer-left', (e) => this._onPeerLeft(e.detail))
  }

  _onMessage(message) {
    if (!this.peers[message.sender]) {
      this.peers[message.sender] = new RTCPeer(this._server)
    }
    this.peers[message.sender].onServerMessage(message)
  }

  _onPeers(peers) {
    peers.forEach(this._onPeer)
  }
  _onPeer(peer) {
    if (this.peers[peer.id]) {
      this.peers[peer.id].refresh()
      return
    }
    this.peers[peer.id] = new RTCPeer(this._server, peer.id)
  }

  sendTo(peerId, message) {
    this.peers[peerId].send(message)
  }

  _onFilesSelected(message) {
    this.peers[message.to].sendFiles(message.files)
  }

  _onSendText(message) {
    this.peers[message.to].sendText(message.text)
  }

  _onPeerLeft(peerId) {
    const peer = this.peers[peerId]
    delete this.peers[peerId]
    if (!peer || !peer._peer) return
    peer._peer.close()
  }
}

class FileChunker {
  constructor(file, onChunk, onPartitionEnd) {
    this._chunkSize = 64000 // 64 KB
    this._maxPartitionSize = 1e6 // 1 MB
    this._offset = 0
    this._partitionSize = 0
    this._file = file
    this._onChunk = onChunk
    this._onPartitionEnd = onPartitionEnd
    this._reader = new FileReader()
    this._reader.addEventListener('load', (e) =>
      this._onChunkRead(e.target.result)
    )
  }

  nextPartition() {
    this._partitionSize = 0
    this._readChunk()
  }

  _readChunk() {
    const chunk = this._file.slice(this._offset, this._offset + this._chunkSize)
    this._reader.readAsArrayBuffer(chunk)
  }

  _onChunkRead(chunk) {
    this._offset += chunk.byteLength
    this._partitionSize += chunk.byteLength
    this._onChunk(chunk)
    if (this.isFileEnd()) return
    if (this._isPartitionEnd()) {
      this._onPartitionEnd(this._offset)
      return
    }
    this._readChunk()
  }

  repeatPartition() {
    this._offset -= this._partitionSize
    this._nextPartition()
  }

  _isPartitionEnd() {
    return this._partitionSize >= this._maxPartitionSize
  }

  isFileEnd() {
    return this._offset >= this._file.size
  }

  get progress() {
    return this._offset / this._file.size
  }
}

class FileDigester {
  constructor(meta, callback) {
    this._buffer = []
    this._bytesReceived = 0
    this._size = meta.size
    this._mime = meta.mime || 'application/octet-stream'
    this._name = meta.name
    this._callback = callback
  }

  unchunk(chunk) {
    this._buffer.push(chunk)
    this._bytesReceived += chunk.byteLength || chunk.size
    const totalChunks = this._buffer.length
    this.progress = this._bytesReceived / this._size
    if (isNaN(this.progress)) this.progress = 1

    if (this._bytesReceived < this._size) return
    // we are done
    let blob = new Blob(this._buffer, { type: this._mime })
    this._callback({
      name: this._name,
      mime: this._mime,
      size: this._size,
      blob: blob,
    })
  }
}

class Events {
  static fire(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail: detail }))
  }

  static on(type, callback) {
    return window.addEventListener(type, callback, false)
  }

  static off(type, callback) {
    return window.removeEventListener(type, callback, false)
  }
}

RTCPeer.config = {
  sdpSemantics: 'unified-plan',
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun.stunprotocol.org:3478',
        'stun:stun.ooma.com:3478',
      ],
    },
  ],
}

console.log(':D')
