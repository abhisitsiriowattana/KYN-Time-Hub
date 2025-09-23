// main.js
// JavaScript for Attendance System

// IndexedDB helper
class AttendanceDB {
  constructor() {
    this.dbName = 'attendanceDB';
    this.storeName = 'attendance';
    this.db = null;
  }
  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, {keyPath: 'id', autoIncrement: true});
        }
      };
      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };
      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }
  async addRecord(data) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.add(data);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }
  async getAllRecords() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.getAll();
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }
}

class AttendanceSystem {
  constructor() {
    this.video = document.getElementById('video');
    this.faceOverlay = document.getElementById('faceOverlay');
    this.startCameraBtn = document.getElementById('startCamera');
    this.checkInBtn = document.getElementById('checkInBtn');
    this.checkOutBtn = document.getElementById('checkOutBtn');
    this.loadingIndicator = document.getElementById('loadingIndicator');
    this.alertContainer = document.getElementById('alertContainer');

    this.currentLocation = null;
    this.isFaceDetected = false;
    this.isCheckedIn = false;
    this.faceDetectionInterval = null;
    this.faceApiLoaded = false;

    this.snapshotCanvas = document.getElementById('snapshotCanvas');
    this.db = new AttendanceDB();
    this.db.open().then(() => {
      this.init();
    });
  }

  init() {
    this.loadFaceApiModels();
    this.updateDateTime();
    this.updateNetworkStatus();
    this.loadAttendanceHistory();
    this.updateDailySummary();
    this.getCurrentLocation();
    this.checkTodayStatus();

    // Event listeners
    this.startCameraBtn.addEventListener('click', () => this.startCamera());
    this.checkInBtn.addEventListener('click', () => this.checkIn());
    this.checkOutBtn.addEventListener('click', () => this.checkOut());

    // Network status listeners
    window.addEventListener('online', () => {
      this.updateNetworkStatus();
      if (!this.faceApiLoaded) {
        this.showAlert('กลับมาออนไลน์แล้ว กำลังโหลด Face Detection ใหม่...', 'info');
        this.loadFaceApiModels();
      }
    });

    window.addEventListener('offline', () => {
      this.updateNetworkStatus();
      this.showAlert('หลุดการเชื่อมต่อ internet จะใช้โหมดจำลอง', 'warning');
    });

    // Update time every second
    setInterval(() => this.updateDateTime(), 1000);

    // Check geolocation every 5 minutes
    setInterval(() => this.getCurrentLocation(), 300000);
  }

  async loadFaceApiModels() {
    try {
      this.showLoading(true);

      // Check network connection first
      if (!this.checkNetworkConnection()) {
        throw new Error('ไม่มีการเชื่อมต่อ internet');
      }

      this.updateFaceStatus('กำลังโหลด Face Detection จาก CDN...');

      // Try multiple CDN sources for better reliability
      const modelSources = [
        'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights',
        'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights'
      ];

      let modelsLoaded = false;
      for (const source of modelSources) {
        try {
          this.updateFaceStatus(`กำลังโหลด SSD MobileNet จาก ${source.includes('github') ? 'GitHub' : 'JSDelivr'}...`);
          await faceapi.nets.ssdMobilenetv1.loadFromUri(source);

          this.updateFaceStatus(`กำลังโหลด Face Landmarks จาก ${source.includes('github') ? 'GitHub' : 'JSDelivr'}...`);
          await faceapi.nets.faceLandmark68Net.loadFromUri(source);

          modelsLoaded = true;
          break;
        } catch (sourceError) {
          console.warn(`Failed to load from ${source}:`, sourceError);
          if (source === modelSources[modelSources.length - 1]) {
            throw sourceError; // Throw the last error if all sources fail
          }
        }
      }

      if (!modelsLoaded) {
        throw new Error('ไม่สามารถโหลด models จาก CDN ใดๆ ได้');
      }

      this.faceApiLoaded = true;
      this.updateFaceStatus('Face Detection พร้อมใช้งาน');
      this.showAlert('โหลด Face Detection สำเร็จ', 'success');

    } catch (error) {
      console.error('Face API loading error:', error);
      this.faceApiLoaded = false;

      if (error.message.includes('internet')) {
        this.updateFaceStatus('ไม่มี internet - ใช้โหมดจำลอง');
        this.showAlert('ไม่มีการเชื่อมต่อ internet จะใช้โหมดจำลอง', 'warning');
      } else {
        this.updateFaceStatus('Face Detection ล้มเหลว - ใช้โหมดจำลอง');
        this.showAlert('ไม่สามารถโหลด Face Detection ได้ จะใช้โหมดจำลอง', 'warning');
      }
    } finally {
      this.showLoading(false);
    }
  }

  updateDateTime() {
    const now = new Date();
    const dateOptions = {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      locale: 'th-TH'
    };
    const timeOptions = {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };

    document.getElementById('currentDate').textContent = now.toLocaleDateString('th-TH', dateOptions);
    document.getElementById('currentTime').textContent = now.toLocaleTimeString('th-TH', timeOptions);
  }

  async startCamera() {
    try {
      this.showLoading(true);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: {ideal: 1280},
          height: {ideal: 720},
          facingMode: 'user'
        }
      });

      this.video.srcObject = stream;
      this.startCameraBtn.disabled = true;
      this.startCameraBtn.textContent = 'กล้องเปิดแล้ว';

      // Wait for video to load before starting face detection
      this.video.addEventListener('loadeddata', () => {
        this.startFaceDetection();
      });

      this.showAlert('เปิดกล้องสำเร็จ', 'success');

    } catch (error) {
      console.error('Camera error:', error);
      this.showAlert('ไม่สามารถเปิดกล้องได้ กรุณาตรวจสอบการอนุญาต', 'error');
    } finally {
      this.showLoading(false);
    }
  }

  startFaceDetection() {
    if (!this.faceApiLoaded) {
      // Fallback to simulation if face-api.js is not loaded
      this.startSimulatedFaceDetection();
      return;
    }

    // Real face detection using face-api.js
    this.faceDetectionInterval = setInterval(async () => {
      try {
        const detections = await faceapi
          .detectAllFaces(this.video, new faceapi.SsdMobilenetv1Options({minConfidence: 0.5}))
          .withFaceLandmarks();

        // Clear previous face boxes
        this.faceOverlay.innerHTML = '';

        if (detections.length > 0) {
          const detection = detections[0]; // Use the first detection
          const confidence = Math.round(detection.detection.score * 100);

          if (!this.isFaceDetected) {
            this.isFaceDetected = true;
            this.updateFaceStatus(`ตรวจพบใบหน้า (${confidence}%)`);
            this.checkInBtn.disabled = false;
            this.checkOutBtn.disabled = false;
          } else {
            this.updateFaceStatus(`ตรวจพบใบหน้า (${confidence}%)`);
          }

          // Draw face detection boxes
          detections.forEach(detection => {
            this.drawFaceBox(detection.detection.box, detection.detection.score);
          });

        } else {
          if (this.isFaceDetected) {
            this.isFaceDetected = false;
            this.updateFaceStatus('ไม่พบใบหน้า');
            this.checkInBtn.disabled = true;
            this.checkOutBtn.disabled = true;
          }
        }
      } catch (error) {
        console.error('Face detection error:', error);
        // Fallback to simulation on error
        this.startSimulatedFaceDetection();
      }
    }, 500); // Check every 500ms for better performance
  }

  startSimulatedFaceDetection() {
    // Fallback simulation mode
    this.faceDetectionInterval = setInterval(() => {
      const isDetected = Math.random() > 0.3; // 70% chance of detection

      if (isDetected && !this.isFaceDetected) {
        this.isFaceDetected = true;
        this.showSimulatedFaceBox();
        this.updateFaceStatus('ตรวจพบใบหน้า (โหมดจำลอง)');
        this.checkInBtn.disabled = false;
        this.checkOutBtn.disabled = false;
      } else if (!isDetected && this.isFaceDetected) {
        this.isFaceDetected = false;
        this.hideFaceBox();
        this.updateFaceStatus('ไม่พบใบหน้า (โหมดจำลอง)');
        this.checkInBtn.disabled = true;
        this.checkOutBtn.disabled = true;
      }
    }, 1000);
  }

  drawFaceBox(box, confidence = 1) {
    const faceBox = document.createElement('div');
    faceBox.className = 'face-box';

    // Calculate position relative to video element
    const videoRect = this.video.getBoundingClientRect();
    const videoDisplayWidth = this.video.offsetWidth;
    const videoDisplayHeight = this.video.offsetHeight;

    // Scale detection box to video display size
    const scaleX = videoDisplayWidth / this.video.videoWidth;
    const scaleY = videoDisplayHeight / this.video.videoHeight;

    faceBox.style.left = (box.x * scaleX) + 'px';
    faceBox.style.top = (box.y * scaleY) + 'px';
    faceBox.style.width = (box.width * scaleX) + 'px';
    faceBox.style.height = (box.height * scaleY) + 'px';

    // Add confidence indicator
    if (confidence < 1) {
      const confidenceLabel = document.createElement('div');
      confidenceLabel.className = 'confidence-label';
      confidenceLabel.textContent = `${Math.round(confidence * 100)}%`;
      confidenceLabel.style.position = 'absolute';
      confidenceLabel.style.top = '-25px';
      confidenceLabel.style.left = '0';
      confidenceLabel.style.background = 'rgba(16, 185, 129, 0.9)';
      confidenceLabel.style.color = 'white';
      confidenceLabel.style.padding = '2px 6px';
      confidenceLabel.style.borderRadius = '4px';
      confidenceLabel.style.fontSize = '12px';
      confidenceLabel.style.fontWeight = 'bold';
      faceBox.appendChild(confidenceLabel);
    }

    this.faceOverlay.appendChild(faceBox);
  }

  showSimulatedFaceBox() {
    // Create simulated face detection box for fallback mode
    const faceBox = document.createElement('div');
    faceBox.className = 'face-box';
    faceBox.style.left = '25%';
    faceBox.style.top = '20%';
    faceBox.style.width = '50%';
    faceBox.style.height = '60%';

    this.faceOverlay.innerHTML = '';
    this.faceOverlay.appendChild(faceBox);
  }

  hideFaceBox() {
    this.faceOverlay.innerHTML = '';
  }

  updateFaceStatus(status) {
    document.getElementById('faceStatus').textContent = status;
  }

  async getCurrentLocation() {
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 300000
        });
      });

      this.currentLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: new Date().toISOString()
      };

      document.getElementById('locationInfo').textContent =
        `ละติจูด: ${position.coords.latitude.toFixed(6)}, ลองจิจูด: ${position.coords.longitude.toFixed(6)}`;
      document.getElementById('locationAccuracy').textContent =
        `ความแม่นยำ: ${Math.round(position.coords.accuracy)} เมตร`;

    } catch (error) {
      console.error('Location error:', error);
      document.getElementById('locationInfo').textContent = 'ไม่สามารถหาตำแหน่งได้';
      document.getElementById('locationAccuracy').textContent = 'กรุณาเปิดการใช้งานตำแหน่ง';
    }
  }

  async checkIn() {
    if (!this.isFaceDetected) {
      this.showAlert('กรุณาตรวจสอบใบหน้าก่อน', 'warning');
      return;
    }
    if (!this.currentLocation) {
      this.showAlert('กรุณารอการตรวจสอบตำแหน่ง', 'warning');
      return;
    }

    this.showLoading(true);
    this.showAlert('กำลังบันทึกการเข้างาน...', 'info');

    const faceImage = await this.captureFaceImage();
    setTimeout(async () => {
      const attendanceData = {
        type: 'check-in',
        timestamp: new Date().toISOString(),
        location: this.currentLocation,
        faceDetected: this.isFaceDetected,
        faceImage: faceImage,
        detectionMethod: this.faceApiLoaded ? 'face-api.js' : 'simulation'
      };

      await this.db.addRecord(attendanceData);
      this.isCheckedIn = true;
      this.updateCurrentStatus('เข้างานแล้ว');

      // Enhanced success feedback
      this.showSuccessNotification('✅ ลงเวลาเข้างานสำเร็จ!', `เวลา: ${new Date().toLocaleTimeString('th-TH')}`);
      this.checkInBtn.style.background = '#10b981';
      this.checkInBtn.textContent = '✓ เข้างานสำเร็จ';

      // Reset button after 3 seconds
      setTimeout(() => {
        this.checkInBtn.style.background = '';
        this.checkInBtn.textContent = 'เข้างาน';
      }, 3000);

      this.loadAttendanceHistory();
      this.updateDailySummary();
      this.showLoading(false);
    }, 2000);
  }

  async checkOut() {
    if (!this.isFaceDetected) {
      this.showAlert('กรุณาตรวจสอบใบหน้าก่อน', 'warning');
      return;
    }
    if (!this.currentLocation) {
      this.showAlert('กรุณารอการตรวจสอบตำแหน่ง', 'warning');
      return;
    }

    this.showLoading(true);
    this.showAlert('กำลังบันทึกการออกงาน...', 'info');

    const faceImage = await this.captureFaceImage();
    setTimeout(async () => {
      const attendanceData = {
        type: 'check-out',
        timestamp: new Date().toISOString(),
        location: this.currentLocation,
        faceDetected: this.isFaceDetected,
        faceImage: faceImage,
        detectionMethod: this.faceApiLoaded ? 'face-api.js' : 'simulation'
      };

      await this.db.addRecord(attendanceData);
      this.isCheckedIn = false;
      this.updateCurrentStatus('ออกงานแล้ว');

      // Enhanced success feedback
      this.showSuccessNotification('✅ ลงเวลาออกงานสำเร็จ!', `เวลา: ${new Date().toLocaleTimeString('th-TH')}`);
      this.checkOutBtn.style.background = '#ef4444';
      this.checkOutBtn.textContent = '✓ ออกงานสำเร็จ';

      // Reset button after 3 seconds
      setTimeout(() => {
        this.checkOutBtn.style.background = '';
        this.checkOutBtn.textContent = 'ออกงาน';
      }, 3000);

      this.loadAttendanceHistory();
      this.updateDailySummary();
      this.showLoading(false);
    }, 2000);
  }

  async captureFaceImage() {
    // Capture current frame from video as dataURL
    const video = this.video;
    const canvas = this.snapshotCanvas;
    canvas.width = video.videoWidth || 480;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Optionally crop to face area if needed
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  // เพิ่มฟังก์ชันรองรับการกรองประวัติด้วย type (all/check-in/check-out)
  async loadAttendanceHistory(type = 'all') {
    const historyContainer = document.getElementById('attendanceHistory');
    let history = [];
    try {
      history = await this.db.getAllRecords();
    } catch (e) {
      history = [];
    }
    if (!history || history.length === 0) {
      historyContainer.innerHTML = '<div class="empty-state"><p>ยังไม่มีประวัติการลงเวลา</p></div>';
      return;
    }
    historyContainer.innerHTML = '';
    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    let filtered = history;
    if (type === 'check-in') filtered = history.filter(r => r.type === 'check-in');
    if (type === 'check-out') filtered = history.filter(r => r.type === 'check-out');
    filtered.slice(0, 50).forEach(record => {
      const historyItem = document.createElement('div');
      historyItem.className = `history-item ${record.type}`;
      const date = new Date(record.timestamp);
      const formattedDate = date.toLocaleDateString('th-TH', {
        year: 'numeric', month: 'long', day: 'numeric'
      });
      const formattedTime = date.toLocaleTimeString('th-TH', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      historyItem.innerHTML = `
        <div class="history-details">
          <h4>${record.type === 'check-in' ? 'เข้างาน' : 'ออกงาน'}</h4>
          <p><strong>วันที่:</strong> ${formattedDate}</p>
          <p><strong>เวลา:</strong> ${formattedTime}</p>
          <p><strong>ตำแหน่ง:</strong> ${record.location.latitude.toFixed(6)}, ${record.location.longitude.toFixed(6)}</p>
          <p><strong>ความแม่นยำ:</strong> ${Math.round(record.location.accuracy)} เมตร</p>
          <p><strong>การตรวจจับ:</strong> ${record.detectionMethod || 'simulation'}</p>
        </div>
        <div class="history-face">
          ${record.faceImage ? `<img src="${record.faceImage}" alt="face" />` : ''}
        </div>
      `;
      historyContainer.appendChild(historyItem);
    });
  }

  async checkTodayStatus() {
    let history = [];
    try {
      history = await this.db.getAllRecords();
    } catch (e) {
      history = [];
    }
    const today = new Date().toDateString();
    const todayRecords = history.filter(record => {
      const recordDate = new Date(record.timestamp).toDateString();
      return recordDate === today;
    });
    const lastCheckIn = todayRecords.find(record => record.type === 'check-in');
    const lastCheckOut = todayRecords.find(record => record.type === 'check-out');
    if (lastCheckIn && !lastCheckOut) {
      this.isCheckedIn = true;
      this.updateCurrentStatus('เข้างานแล้ว');
    } else if (lastCheckOut) {
      this.isCheckedIn = false;
      this.updateCurrentStatus('ออกงานแล้ว');
    }
  }

  updateCurrentStatus(status) {
    document.getElementById('currentStatus').textContent = status;
  }

  showAlert(message, type) {
    const alert = document.createElement('div');
    alert.className = `alert ${type}`;
    alert.textContent = message;

    this.alertContainer.innerHTML = '';
    this.alertContainer.appendChild(alert);

    setTimeout(() => {
      alert.remove();
    }, 5000);
  }

  showSuccessNotification(title, subtitle) {
    // Create enhanced success notification
    const notification = document.createElement('div');
    notification.className = 'success-notification';
    notification.innerHTML = `
      <div class="notification-icon">🎉</div>
      <div class="notification-content">
        <h3>${title}</h3>
        <p>${subtitle}</p>
      </div>
    `;

    // Add to container
    this.alertContainer.innerHTML = '';
    this.alertContainer.appendChild(notification);

    // Add entrance animation
    notification.style.transform = 'translateY(-20px)';
    notification.style.opacity = '0';

    setTimeout(() => {
      notification.style.transform = 'translateY(0)';
      notification.style.opacity = '1';
    }, 100);

    // Auto remove after 5 seconds
    setTimeout(() => {
      notification.style.transform = 'translateY(-20px)';
      notification.style.opacity = '0';
      setTimeout(() => notification.remove(), 300);
    }, 5000);

    // Add vibration if supported
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200]);
    }

    // Play success sound
    this.playSuccessSound();
  }

  playSuccessSound() {
    // Create a simple success tone using Web Audio API
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Create success melody
      const frequencies = [523.25, 659.25, 783.99]; // C5, E5, G5
      const duration = 0.15;

      frequencies.forEach((freq, index) => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.frequency.setValueAtTime(freq, audioContext.currentTime + index * duration);
        oscillator.type = 'sine';

        gainNode.gain.setValueAtTime(0, audioContext.currentTime + index * duration);
        gainNode.gain.linearRampToValueAtTime(0.1, audioContext.currentTime + index * duration + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + index * duration + duration);

        oscillator.start(audioContext.currentTime + index * duration);
        oscillator.stop(audioContext.currentTime + index * duration + duration);
      });
    } catch (error) {
      console.log('Audio not supported:', error);
    }
  }

  showLoading(show) {
    this.loadingIndicator.style.display = show ? 'block' : 'none';
  }

  // เพิ่มฟังก์ชันตรวจสอบการเชื่อมต่อ network
  checkNetworkConnection() {
    return navigator.onLine;
  }

  updateNetworkStatus() {
    const isOnline = this.checkNetworkConnection();
    const statusElement = document.getElementById('networkStatus');
    if (statusElement) {
      statusElement.textContent = isOnline ? 'ออนไลน์' : 'ออฟไลน์';
      statusElement.style.color = isOnline ? '#10b981' : '#ef4444';
    }
  }

  updateDailySummary() {
    this.db.getAllRecords().then(history => {
      const today = new Date().toDateString();
      const todayRecords = history.filter(record => {
        const recordDate = new Date(record.timestamp).toDateString();
        return recordDate === today;
      });

      const checkInRecord = todayRecords.find(r => r.type === 'check-in');
      const checkOutRecord = todayRecords.find(r => r.type === 'check-out');

      document.getElementById('todayCheckIn').textContent =
        checkInRecord ? new Date(checkInRecord.timestamp).toLocaleTimeString('th-TH', {hour: '2-digit', minute: '2-digit'}) : '-';

      document.getElementById('todayCheckOut').textContent =
        checkOutRecord ? new Date(checkOutRecord.timestamp).toLocaleTimeString('th-TH', {hour: '2-digit', minute: '2-digit'}) : '-';
    }).catch(() => {
      document.getElementById('todayCheckIn').textContent = '-';
      document.getElementById('todayCheckOut').textContent = '-';
    });
  }
}

// ให้ AttendanceSystem เป็น global เพื่อให้สคริปต์ใน index.html เรียกใช้ได้
window.attendanceSystem = new AttendanceSystem();

// Initialize the system when page loads
window.addEventListener('DOMContentLoaded', () => {
  new AttendanceSystem();
});
