import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './App.css';

const socket = io("http://localhost:5000");

// ---------------- Encryption Helpers ----------------
const deriveKey = async (password) => {
  const encoder = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const salt = encoder.encode("static-salt"); // Optional: make dynamic per room
  return await window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

const encryptText = async (text, key) => {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(ciphertext)),
  };
};

const decryptText = async ({ iv, data }, key) => {
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(data)
  );

  return new TextDecoder().decode(decrypted);
};
// -----------------------------------------------------

function AudioPlayer({ src, index, audioRefs, onPlayOther }) {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      onPlayOther(index);
      audio.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e) => {
    const audio = audioRef.current;
    if (audio) {
      const value = e.target.value;
      audio.currentTime = (value / 100) * audio.duration;
      setProgress(value);
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const updateProgress = () => {
      setProgress((audio.currentTime / audio.duration) * 100);
    };

    const handleEnded = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', updateProgress);
      audio.removeEventListener('ended', handleEnded);
    };
  }, []);

  useEffect(() => {
    audioRefs.current[index] = audioRef.current;
  }, [audioRef.current]);

  return (
    <div className="audio-wrapper">
      <button className="audio-button" onClick={togglePlayPause}>
        {isPlaying ? '❚❚' : '▶'}
      </button>
      <input
        type="range"
        className="audio-seek"
        value={progress}
        onChange={handleSeek}
        min="0"
        max="100"
        step="0.1"
        style={{
          background: `linear-gradient(to right, #e94560 ${progress}%, #444 ${progress}%)`
        }}
      />
      <audio ref={audioRef} src={src} preload="auto" />
    </div>
  );
}

export default function App() {
  const [username, setUsername] = useState('');
  const [room, setRoom] = useState('');
  const [joined, setJoined] = useState(false);
  const [usersInRoom, setUsersInRoom] = useState([]);
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState([]);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [cryptoKey, setCryptoKey] = useState(null);
  const chatEndRef = useRef(null);
  const audioRefs = useRef({});

  useEffect(() => {
    socket.on('usersInRoom', setUsersInRoom);

    socket.on('message', async (data) => {
      if (data.text && cryptoKey) {
        try {
          const decrypted = await decryptText(data.text, cryptoKey);
          data.text = decrypted;
        } catch {
          data.text = '[Encrypted]';
        }
      }
      setChat(prev => [...prev, data]);
    });

    socket.on('roomHistory', async (messages) => {
      const decrypted = await Promise.all(messages.map(async (msg) => {
        if (msg.text && cryptoKey) {
          try {
            const decryptedText = await decryptText(msg.text, cryptoKey);
            return { ...msg, text: decryptedText };
          } catch {
            return { ...msg, text: '[Encrypted]' };
          }
        }
        return msg;
      }));
      setChat(decrypted);
    });

    return () => {
      socket.off('usersInRoom');
      socket.off('message');
      socket.off('roomHistory');
    };
  }, [cryptoKey]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

  const joinRoom = async () => {
    if (!username.trim() || !room.trim()) return;
    const key = await deriveKey(room); // you can use a separate passphrase if preferred
    setCryptoKey(key);
    socket.emit('joinRoom', { username, room });
    setJoined(true);
  };

  const sendMessage = async () => {
    if ((!message.trim() && !file) || !cryptoKey) return;

    let encryptedText = null;
    if (message.trim()) {
      encryptedText = await encryptText(message.trim(), cryptoKey);
    }

    const msg = {
      from: username,
      room,
      text: encryptedText,
    };

    if (file) {
      msg.file = {
        name: file.name,
        type: file.type,
        url: URL.createObjectURL(file), // not encrypted
      };
    }

    socket.emit('message', msg);
    setMessage('');
    setFile(null);
  };

  const handleFileChange = (e) => {
    const selected = e.target.files[0];
    if (!selected) return;
    setFile(selected);
  };

  const openPreview = (url, type) => {
    setPreview({ url, type });
  };

  const closePreview = () => {
    setPreview(null);
  };

  const handleAudioPlay = (index) => {
    Object.entries(audioRefs.current).forEach(([key, audio]) => {
      if (parseInt(key) !== index && audio && !audio.paused) {
        audio.pause();
        audio.currentTime = 0;
      }
    });
  };

  const renderMessage = (text) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);
    return parts.map((part, i) =>
      urlRegex.test(part) ? (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer">
          {part}
        </a>
      ) : (
        part
      )
    );
  };

  return (
    <div className="container">
      {!joined ? (
        <div className="login-box">
          <h1>Join Chat</h1>
          <input placeholder="Enter your name" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input placeholder="Enter room ID" value={room} onChange={(e) => setRoom(e.target.value)} />
          <button onClick={joinRoom}>Enter</button>
        </div>
      ) : (
        <div className="chat-box">
          <div className="user-list" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div><strong>Users in Room:</strong> {usersInRoom.map(u => u.username).join(', ')}</div>
            <div><strong>Room:</strong> {room}</div>
          </div>

          <div className="chat-window">
            {chat.map((msg, i) => (
              <div className={`chat-line ${msg.from === username ? 'sent' : 'received'}`} key={i}>
                <div className="chat-message">
                  <div className="sender-name">{msg.from}</div>
                  {msg.text && <div>{renderMessage(msg.text)}</div>}
                  {msg.file && (
                    <>
                      {msg.file.type.startsWith('image') && (
                        <img
                          src={msg.file.url}
                          className="chat-image"
                          onClick={() => openPreview(msg.file.url, 'image')}
                          alt="sent-img"
                        />
                      )}
                      {msg.file.type.startsWith('video') && (
                        <video
                          src={msg.file.url}
                          controls
                          className="chat-image"
                          onClick={() => openPreview(msg.file.url, 'video')}
                        />
                      )}
                      {msg.file.type.startsWith('audio') && (
                        <AudioPlayer
                          src={msg.file.url}
                          index={i}
                          audioRefs={audioRefs}
                          onPlayOther={handleAudioPlay}
                        />
                      )}
                      {!msg.file.type.startsWith('image') &&
                        !msg.file.type.startsWith('video') &&
                        !msg.file.type.startsWith('audio') && (
                          <a href={msg.file.url} download={msg.file.name}>
                            📎 {msg.file.name}
                          </a>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="input-row">
            <input
              type="text"
              placeholder="Type a message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />

            <label className="file-upload-label">
              {file ? file.name : "Choose File"}
              <input
                type="file"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </label>

            <button onClick={sendMessage}>Send</button>
          </div>
        </div>
      )}

      {preview && (
        <div className="preview-popup" onClick={closePreview}>
          {preview.type === 'image' ? (
            <img src={preview.url} alt="Preview" />
          ) : preview.type === 'video' ? (
            <video src={preview.url} controls autoPlay />
          ) : null}
        </div>
      )}

      <div className="footer-note">Crafted by SK</div>

    </div>
  );
}
