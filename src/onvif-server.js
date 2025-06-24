const soap = require('soap');
const http = require('http');
const dgram = require('dgram');
const xml2js = require('xml2js');
const uuid = require('node-uuid');
const url = require('url');
const fs = require('fs');
const os = require('os');

Date.prototype.stdTimezoneOffset = function() {
    let jan = new Date(this.getFullYear(), 0, 1);
    let jul = new Date(this.getFullYear(), 6, 1);
    return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

Date.prototype.isDstObserved = function() {
    return this.getTimezoneOffset() < this.stdTimezoneOffset();
}

function getIpAddressFromMac(macAddress) {
    let networkInterfaces = os.networkInterfaces();
    for (let iface in networkInterfaces) {
        for (let network of networkInterfaces[iface]) {
            if (network.family == 'IPv4' && network.mac && macAddress && network.mac.toLowerCase() === macAddress.toLowerCase())
                return network.address;
        }
    }
    return null;
}

class OnvifServer {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;

        // Docker-friendly options
        this.bindAddress      = config.bindAddress      || '0.0.0.0';
        this.disableDiscovery = config.disableDiscovery || false;
        this.disableMulticast = config.disableMulticast || false;

        // Determine advertised hostname
        if (config.onvifHost) {
            this.config.hostname = config.onvifHost;
        } else if (!this.config.hostname && this.config.mac) {
            this.config.hostname = getIpAddressFromMac(this.config.mac);
        }
        this.config.hostname = this.config.hostname || '127.0.0.1';

        // Video source and encoder profiles
        this.videoSource = { attributes: { token: 'video_src_token' }, Framerate: this.config.highQuality.framerate, Resolution: { Width: this.config.highQuality.width, Height: this.config.highQuality.height } };
        this.profiles = [ /* unchanged profile definitions */ ];
        if (this.config.lowQuality) { /* unchanged secondary profile */ }

        this.onvif = { /* unchanged services definitions */ };
    }

    listen(request, response) {
        let action = url.parse(request.url, true).pathname;
        if (action === '/snapshot.png') {
            let image = fs.readFileSync('./resources/snapshot.png');
            response.writeHead(200, {'Content-Type': 'image/png'});
            response.end(image, 'binary');
        } else {
            response.writeHead(404, {'Content-Type': 'text/plain'});
            response.end('404 Not Found\n');
        }
    }

    startServer() {
        // Bind HTTP server on all interfaces
        this.server = http.createServer(this.listen.bind(this));
        this.server.listen(this.config.ports.server, this.bindAddress);

        this.deviceService = soap.listen(this.server, {
            path: '/onvif/device_service', services: this.onvif,
            xml: fs.readFileSync('./wsdl/device_service.wsdl', 'utf8'), forceSoap12Headers: true
        });
        this.mediaService = soap.listen(this.server, {
            path: '/onvif/media_service', services: this.onvif,
            xml: fs.readFileSync('./wsdl/media_service.wsdl', 'utf8'), forceSoap12Headers: true
        });
    }

    enableDebugOutput() { /* unchanged */ }

    startDiscovery() {
        if (this.disableDiscovery) {
            console.log('WS-Discovery disabled');
            return;
        }
        this.discoveryMessageNo = 0;
        this.discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.discoverySocket.on('message', (message, remote) => { /* unchanged */ });

        this.discoverySocket.bind(3702, () => {
            if (!this.disableMulticast) {
                try {
                    this.discoverySocket.addMembership('239.255.255.250', this.bindAddress);
                } catch (e) {
                    // ignore
                }
            }
        });
    }

    getHostname() {
        return this.config.hostname;
    }
}

function createServer(config) {
    return new OnvifServer(config);
}

exports.createServer = createServer;