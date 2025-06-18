const axios = require('axios');

class RealDebridAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = 'https://api.real-debrid.com/rest/1.0';
    this.headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    };
  }

  async checkInstantAvailability(infoHash) {
    if (!this.apiKey) return null;
    
    try {
      console.log(`🔍 Checking RD cache for: ${infoHash}`);
      const response = await axios.get(
        `${this.baseURL}/torrents/instantAvailability/${infoHash}`,
        { headers: this.headers, timeout: 10000 }
      );
      
      const available = Object.keys(response.data).length > 0;
      console.log(`${available ? '✅' : '❌'} RD Cache: ${available ? 'HIT' : 'MISS'}`);
      return available ? response.data : null;
      
    } catch (error) {
      console.log(`❌ RD Cache check failed: ${error.response?.status} - ${error.response?.data?.error || error.message}`);
      return null;
    }
  }

  async addMagnetAndWait(magnetLink, maxWaitMinutes = 3) {
    if (!this.apiKey) return null;
    
    try {
      console.log(`⏳ Adding magnet to RD queue...`);
      
      // OPRAVENÝ formát pro přidání magnetu
      const addResponse = await axios.post(
        `${this.baseURL}/torrents/addMagnet`,
        `magnet=${encodeURIComponent(magnetLink)}`, // URL-encoded format
        { 
          headers: this.headers, 
          timeout: 15000 
        }
      );
      
      const torrentId = addResponse.data.id;
      console.log(`📥 Torrent added to RD: ${torrentId}`);

      // Vybrat všechny soubory
      await axios.post(
        `${this.baseURL}/torrents/selectFiles/${torrentId}`,
        'files=all', // URL-encoded format
        { 
          headers: this.headers, 
          timeout: 10000 
        }
      );

      // Čekat na dokončení
      const maxAttempts = maxWaitMinutes * 6; // 10s intervaly
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        
        const infoResponse = await axios.get(
          `${this.baseURL}/torrents/info/${torrentId}`,
          { headers: this.headers, timeout: 10000 }
        );

        const status = infoResponse.data.status;
        const progress = infoResponse.data.progress || 0;
        
        console.log(`⏳ RD Progress: ${progress}% (${status}) - ${attempt}/${maxAttempts}`);

        if (status === 'downloaded') {
          console.log(`✅ RD Download completed!`);
          return await this.getDownloadLinks(infoResponse.data.links);
        }

        if (status === 'error' || status === 'virus' || status === 'dead') {
          console.log(`❌ RD Download failed: ${status}`);
          return null;
        }

        // Čekat 10 sekund před dalším pokusem
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      console.log(`⏰ RD Download timeout after ${maxWaitMinutes} minutes`);
      return null;

    } catch (error) {
      console.error(`❌ RD Add magnet failed: ${error.response?.status} - ${error.response?.data?.error || error.message}`);
      return null;
    }
  }

  async getDownloadLinks(rdLinks) {
    try {
      const downloadLinks = [];
      
      for (const link of rdLinks.slice(0, 3)) { // Max 3 soubory
        const unrestrictResponse = await axios.post(
          `${this.baseURL}/unrestrict/link`,
          `link=${encodeURIComponent(link)}`, // URL-encoded format
          { 
            headers: this.headers, 
            timeout: 10000 
          }
        );
        
        downloadLinks.push({
          filename: unrestrictResponse.data.filename,
          url: unrestrictResponse.data.download,
          filesize: unrestrictResponse.data.filesize
        });
      }
      
      return downloadLinks;
      
    } catch (error) {
      console.error(`❌ RD Get download links failed: ${error.response?.status} - ${error.response?.data?.error || error.message}`);
      return null;
    }
  }
}

module.exports = RealDebridAPI;
