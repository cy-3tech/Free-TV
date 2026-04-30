# Mylo-TV
> A lightweight global TV streaming grid & aggregator by **DTGODEV**
> <img>TV.png</img>
## 📖 Overview
**MYLO-TV** is a browser-based web application designed to fetch, organize, and play live TV channels from around the world. It provides a centralized stream grid with real-time country/channel filtering, adjustable interface density, and an intelligent stream recovery system to ensure smooth playback.

⚠️ **Disclaimer:** This application **does not host** any copyrighted content. It functions purely as an index/aggregator for publicly available stream metadata and endpoints.

## ✨ Features
- 🌍 **Global Channel Grid**: Access and browse international channels in one unified interface.
- 🔍 **Smart Filtering**: Quickly select by country and search for specific channels.
- 📊 **Adjustable Channel Density**: Toggle between `None` (minimal) and `500+` channels to optimize UI performance.
- 🔄 **Automatic Fallback & Retry**: Built-in stream manager that automatically switches to backup sources if the primary stream fails.
- 📡 **Real-time Status Indicators**: Live UI feedback for signal acquisition, stream switching, and error states.
- 🛡️ **Zero Hosting Liability**: Aggregates only; no media files are stored, cached, or distributed.

## 🚀 Getting Started

### Prerequisites
- A modern web browser (Chrome, Firefox, Edge, Safari, etc.)
- Stable internet connection for fetching channel/stream data

### Installation
1. Clone or download the project:
```bash
   git clone https://github.com/cy-3tech/Free-TV
   cd Mylo-TV
```
2. Open `index.html` directly in your browser, or serve it locally:
```bash
   # Python 3
   python -m http.server 8080
   # Node.js
   npx serve .
```
3. Navigate to `http://localhost:8080` in your browser.

## 💡 Usage
1. **Select a Country**: Use the country dropdown to filter regional channels.
2. **Choose a Channel**: Pick your desired station from the grid or list.
3. **Adjust Density**: Use the density toggle to control how many channels load simultaneously.
4. **Playback & Recovery**: 
   - The app will automatically attempt fallback streams if the primary source fails.
   - Use the `Retry` or `Next Stream ⏵` buttons to manually cycle through available sources.

## 🛠️ Architecture & Workflow
1. **Initialization**: App loads the Global Stream Grid and begins fetching channel metadata, stream URLs, and satellite data.
2. **Filtering & Selection**: User inputs dynamically filter the channel list.
3. **Stream Resolution**: The player attempts to connect to the primary endpoint.
4. **Fallback Handling**: On failure, the app logs `🔌 Primary stream failed. Attempting fallback...` and automatically retries alternate sources.
5. **Error State**: If all endpoints fail, `⚠️ All streams unavailable for this channel.` is displayed with manual retry/next options.

## 📜 Legal & Disclaimer
- This project is intended for **educational and personal use only**.
- No copyrighted content is hosted or distributed by this application.
- All stream data is fetched from external, publicly available sources. Users are responsible for complying with local broadcasting laws and copyright regulations in their region.

🤝 Contributing
Contributions, bug reports, and feature requests are welcome!
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m 'Add your feature'`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Pull Request

 📧 Contact & Credits
- Developer: DTGODEV
- Project: Mylo-TV
- License: MIT

---
*Built with ❤️ by DTGODEV | 📡 Streaming the world, responsibly.*

