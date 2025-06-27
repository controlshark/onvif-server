const soap = require('soap');
const http = require('http');
const dgram = require('dgram');
const xml2js = require('xml2js');
const uuid = require('node-uuid');
const url = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
/*
Date.prototype.stdTimezoneOffset = function()
{
	const jan = new Date(this.getFullYear(), 0, 1);
	const jul = new Date(this.getFullYear(), 6, 1);
	return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

Date.prototype.isDstObserved = function()
{
	return this.getTimezoneOffset() < this.stdTimezoneOffset();
}
*/
function getIpAddressFromMac(macAddress)
{
	const networkInterfaces = os.networkInterfaces();
	for (let iface in networkInterfaces)
	{
		for (let network of networkInterfaces[iface])
		{
			if (network.family == 'IPv4'
				&& network.mac
				&& macAddress
				&& network.mac.toLowerCase() === macAddress.toLowerCase())
			{
				return network.address;
			}
		}
	}
	return null;
}

class OnvifServer
{
	constructor(config, logger)
	{
		this.config = config;
		this.logger = logger;

		this.bindAddress      = config.bindAddress      || '0.0.0.0';
		this.disableDiscovery = config.disableDiscovery || false;
		this.disableMulticast = config.disableMulticast || false;

		console.log('📡 Determining ONVIF advertised hostname...');
		console.log('🔧 Initial config.onvifHost:', config.onvifHost);
		console.log('🔧 Initial config.mac:', this.config.mac);
		console.log('🔧 Current this.config.hostname:', this.config.hostname);

		if (config.onvifHost)
		{
			console.log('✅ Using explicitly configured onvifHost:', config.onvifHost);
			this.config.hostname = config.onvifHost;
		}
		else if (!this.config.hostname && this.config.mac)
		{
			console.log('ℹ️ No hostname yet. Attempting to resolve from MAC:', this.config.mac);
			this.config.hostname = getIpAddressFromMac(this.config.mac);
			console.log('🔁 Resolved IP from MAC:', this.config.hostname);
		}

		this.config.hostname = this.config.hostname || '127.0.0.1';
		console.log('✅ Final advertised hostname:', this.config.hostname);

		this.videoSource =
		{
			attributes: { token: 'video_src_token' },
			Framerate: this.config.highQuality.framerate,
			Resolution: {
				Width: this.config.highQuality.width,
				Height: this.config.highQuality.height
			}
		};

		this.profiles = [ 
			{
				Name: 'MainStream',
				attributes: {
					token: 'main_stream'
				},
				token: 'main_stream',
				VideoSourceConfiguration: {
					Name: 'VideoSource',
					UseCount: 2,
					attributes: {
						token: 'video_src_config_token'
					},
					SourceToken: 'video_src_token',
					Bounds: { attributes: { x: 0, y: 0, width: this.config.highQuality.width, height: this.config.highQuality.height } }
				},
				VideoEncoderConfiguration: {
					attributes: {
						token: 'encoder_hq_config_token'
					},
					Name: 'CardinalHqCameraConfiguration',
					UseCount: 1,
					Encoding: 'H264',
					Resolution: {
						Width: this.config.highQuality.width,
						Height: this.config.highQuality.height
					},
					Quality: this.config.highQuality.quality,
					RateControl: {
						FrameRateLimit: this.config.highQuality.framerate,
						EncodingInterval: 1,
						BitrateLimit: this.config.highQuality.bitrate
					},
					H264: {
						GovLength: this.config.highQuality.framerate,
						H264Profile: 'Main'
					},
					SessionTimeout: 'PT1000S'
				}
			}
		];

		if (this.config.lowQuality)
		{
			this.profiles.push(
                {
                    Name: 'SubStream',
                    attributes: {
                        token: 'sub_stream'
                    },
						  token: 'sub_stream',
                    VideoSourceConfiguration: {
                        Name: 'VideoSource',
                        UseCount: 1,
                        attributes: {
                            token: 'video_src_config_token'
                        },
                        SourceToken: 'video_src_token',
                        Bounds: { attributes: { x: 0, y: 0, width: this.config.highQuality.width, height: this.config.highQuality.height } }
                    },
                    VideoEncoderConfiguration: {
                        attributes: {
                            token: 'encoder_lq_config_token'
                        },
                        Name: 'CardinalLqCameraConfiguration',
                        UseCount: 1,
                        Encoding: 'H264',
                        Resolution: {
                            Width: this.config.lowQuality.width,
                            Height: this.config.lowQuality.height
                        },
                        Quality: this.config.lowQuality.quality,
                        RateControl: {
                            FrameRateLimit: this.config.lowQuality.framerate,
                            EncodingInterval: 1,
                            BitrateLimit: this.config.lowQuality.bitrate
                        },
                        H264: {
                            GovLength: this.config.lowQuality.framerate,
                            H264Profile: 'Main'
                        },
                        SessionTimeout: 'PT1000S'
                    }
                }
            );
		}

		this.onvif = { 
            DeviceService: {
                Device: {
									GetSystemDateAndTime: () =>
									{
										const now = new Date();

										const jan = new Date(now.getFullYear(), 0, 1);
										const jun = new Date(now.getFullYear(), 6, 1);

										const currentOffsetMin = now.getTimezoneOffset();
										const janOffsetMin = jan.getTimezoneOffset();
										const junOffsetMin = jun.getTimezoneOffset();

										const isDst = currentOffsetMin < Math.max(janOffsetMin, junOffsetMin);
										const offsetHours = -currentOffsetMin / 60;
										const tz = 'UTC' + (offsetHours < 0 ? '-' : '+') + Math.abs(offsetHours);

										const response = {
											SystemDateAndTime: {
												DateTimeType: 'NTP',
												DaylightSavings: isDst,
												TimeZone: { TZ: tz },
												UTCDateTime: {
													Time: {
														Hour: now.getUTCHours(),
														Minute: now.getUTCMinutes(),
														Second: now.getUTCSeconds()
													},
													Date: {
														Year: now.getUTCFullYear(),
														Month: now.getUTCMonth() + 1,
														Day: now.getUTCDate()
													}
												},
												LocalDateTime: {
													Time: {
														Hour: now.getHours(),
														Minute: now.getMinutes(),
														Second: now.getSeconds()
													},
													Date: {
														Year: now.getFullYear(),
														Month: now.getMonth() + 1,
														Day: now.getDate()
													}
												},
												Extension: {}
											}
										};

										return response;
									},
        
                    GetCapabilities: (args) => {
                        let response = {
                            Capabilities: {}
                        };
                
                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Device') {
                            response.Capabilities['Device'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`,
                                Network: {
                                    IPFilter: false,
                                    ZeroConfiguration: false,
                                    IPVersion6: false,
                                    DynDNS: false,
                                    Extension: {
                                        Dot11Configuration: false,
                                        Extension: {}
                                    }
                                },
                                System: {
                                    DiscoveryResolve: false,
                                    DiscoveryBye: false,
                                    RemoteDiscovery: false,
                                    SystemBackup: false,
                                    SystemLogging: false,
                                    FirmwareUpgrade: false,
                                    SupportedVersions: {
                                        Major: 2,
                                        Minor: 5
                                    },
                                    Extension: {
                                        HttpFirmwareUpgrade: false,
                                        HttpSystemBackup: false,
                                        HttpSystemLogging: false,
                                        HttpSupportInformation: false,
                                        Extension: {}
                                    }
                                },
                                IO: {
                                    InputConnectors: 0,
                                    RelayOutputs: 1,
                                    Extension: {
                                        Auxiliary: false,
                                        AuxiliaryCommands: '',
                                        Extension: {}
                                    }
                                },
                                Security: {
                                    'TLS1.1': false,
                                    'TLS1.2': false,
                                    OnboardKeyGeneration: false,
                                    AccessPolicyConfig: false,
                                    'X.509Token': false,
                                    SAMLToken: false,
                                    KerberosToken: false,
                                    RELToken: false,
                                    Extension: {
                                        'TLS1.0': false,
                                        Extension: {
                                            Dot1X: false,
                                            RemoteUserHandling: false
                                        }
                                    }
                                },
                                Extension: {}
                            };
                        }
                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Media') {
                            response.Capabilities['Media'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service`,
                                StreamingCapabilities: {
                                    RTPMulticast: false,
                                    RTP_TCP: true,
                                    RTP_RTSP_TCP: true,
                                    Extension: {}
                                },
                                Extension: {
                                    ProfileCapabilities: {
                                        MaximumNumberOfProfiles: this.profiles.length
                                    }
                                }
                            }
                        }

                        return response;
                    },
        
                    GetServices: (args) => {
                        return {
                            Service : [
                                {
                                    Namespace : 'http://www.onvif.org/ver10/device/wsdl',
                                    XAddr : `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`,
                                    Version : { 
                                        Major : 2,
                                        Minor : 5,
                                    }
                                },
                                { 
                                    Namespace : 'http://www.onvif.org/ver10/media/wsdl',
                                    XAddr : `http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service`,
                                    Version : { 
                                        Major : 2,
                                        Minor : 5,
                                    }
                                }
                            ]
                        };
                    },
                
                    GetDeviceInformation: (args) => {
                        return {
                            Manufacturer: 'Coles',
                            Model: 'ESP32',
                            FirmwareVersion: '1.0.0',
                            SerialNumber: `${this.config.name.replace(' ', '_')}-0000`,
                            HardwareId: `${this.config.name.replace(' ', '_')}-1001`
                        };
                    },
                
                  	GetNetworkInterfaces: (args) => {
								return {
									NetworkInterfaces:
									[{
										attributes: { token: 'eth0' },
										Enabled: true,
										Info: {
											Name: 'eth0',
									HwAddress: '06:A9:24:1A:74:5F',
											MTU: 1500
										},
										IPv4: {
											Enabled: true,
											Config: {
												Manual: {
													Address: '192.168.7.98',
													PrefixLength: 24
												},
												DHCP: false
											}
										}
									}]
								};
							}
                }
            },
        
            MediaService: {
                Media: {
                    GetProfiles: (args) => {
                        return {
                            Profiles: this.profiles
                        };
                    },
        
                    GetProfile: (args) => {
							    console.log('📋 GetProfile called with args:', args);
									const token   = args.ProfileToken || args.token;
									const profile = this.profiles.find(p => p.attributes.token === token);
									if (!profile) {
										throw {
												Fault: {
													Code:   { Value: 'SOAP-ENV:Client' },
													Reason: { Text: 'InvalidProfileToken' }
												}
										};
									}
                        return {
                            Profiles: [ profile ]
                        };
                    },
        
                    GetVideoSources: (args) => {
                        return {
                            VideoSources: [
                                this.videoSource
                            ]
                        };
                    },
        
                    GetSnapshotUri: (args) => {
                        let uri = `http://${this.config.hostname}:${this.config.ports.server}/snapshot.png`;
                        if (args.ProfileToken == 'sub_stream' && this.config.lowQuality && this.config.lowQuality.snapshot)
                            uri = `http://${this.config.hostname}:${this.config.ports.snapshot}${this.config.lowQuality.snapshot}`;
                        else if (this.config.highQuality.snapshot)
                            uri = `http://${this.config.hostname}:${this.config.ports.snapshot}${this.config.highQuality.snapshot}`;

                        return {
                            MediaUri : {
                                Uri: uri,
                                InvalidAfterConnect : false,
                                InvalidAfterReboot : false,
                                Timeout : 'PT30S'
                            }
                        };
                    },
                
                    GetStreamUri: (args) => {
                        let path = this.config.highQuality.rtsp;
                        if (args.ProfileToken == 'sub_stream' && this.config.lowQuality)
                            path = this.config.lowQuality.rtsp;

                        return {
                            MediaUri: {
                                Uri: `rtsp://admin:password@${this.config.hostname}:${this.config.ports.rtsp}${path}`,
                                InvalidAfterConnect: false,
                                InvalidAfterReboot: false,
                                Timeout: 'PT30S'
                            }
                        };
                    }
                }
            }
        };
	}
startServer()
{
	this.server = http.createServer();
	this.server.on('request', (req, res) =>
	{
		// Only handle non-ONVIF, non-snapshot requests
		if (!req.url.startsWith('/onvif/') && req.url !== '/snapshot.png')
		{
			console.log(`🌐 Unhandled HTTP request → ${req.method} ${req.url}`);
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('404 Not Found\n');
		}
	});

	// Attach SOAP handlers to get the request listeners
	const deviceWsdl = generateDeviceWsdl(`${this.config.hostname}:${this.config.ports.server}`);
	const mediaWsdl  = generateMediaWsdl(`${this.config.hostname}:${this.config.ports.server}`);

	this.deviceService = soap.listen(this.server,
	{
		path: '/onvif/device_service',
		services: this.onvif,
		xml: deviceWsdl,
		forceSoap12Headers: true
	});

	this.mediaService = soap.listen(this.server,
	{
		path: '/onvif/media_service',
		services: this.onvif,
		xml: mediaWsdl,
		forceSoap12Headers: true
	});
	
	this.server.listen(this.config.ports.server, this.bindAddress, () =>
	{
		console.log(`🚀 Server listening on ${this.bindAddress}:${this.config.ports.server}`);
	});

		if (this.config.debug)
		{
			this.enableDebugOutput();
		}
	}

	enableDebugOutput()
	{

		// Hook into every SOAP request so you see the methodName
		this.deviceService.on('request', (xml, methodName) =>
		{
			console.log("🐸 DeviceService: " + methodName);
		});
		
		this.mediaService.on('request', (xml, methodName) =>
		{
			console.log("📬 MediaService: " + methodName);
		});

		this.deviceService.on('response', (xml, methodName) =>
		{
			//console.log(`🐸 DeviceService response: ${methodName}`);
			//console.log('📤 Response XML:', xml);
		});

		this.mediaService.on('response', (xml, methodName) =>
		{
			//console.log(`📬 MediaService response: ${methodName}`);
			//console.log('📤 Response XML:', xml);
		});
	}

	startDiscovery()
	{
		if (this.disableDiscovery)
		{
			console.log('❌ WS-Discovery disabled');
			return;
		}

		console.log('✅ WS-Discovery enabled');

		this.discoveryMessageNo = 0;
		this.discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

		this.discoverySocket.on('error', (err) =>
		{
			console.error('❗ Discovery socket error:', err);
		});

		this.discoverySocket.on('message', (message, remote) =>
		{
			console.log(`    • Received discovery message from ${remote.address}:${remote.port}`);
			xml2js.parseString(message.toString(), { tagNameProcessors: [xml2js['processors'].stripPrefix] }, (err, result) => {
				if (err || !result)
				{
					console.error('❗ Failed to parse discovery XML:', err);
					return;
				}

				let probeUuid = result?.Envelope?.Header?.[0]?.MessageID?.[0] ?? '';
				let probeType = '';

				try {
					probeType = result?.Envelope?.Body?.[0]?.Probe?.[0]?.Types?.[0] ?? '';
				} catch (_) {
					probeType = '';
				}

				if (typeof probeType === 'object') probeType = probeType._;
				if (typeof probeUuid === 'object') probeUuid = probeUuid._;

				console.log(`    • Probe received with UUID: ${probeUuid}`);
				console.log(`    • Probe type: ${probeType || '(none)'}`);

				if (probeType === '' || probeType.includes('NetworkVideoTransmitter')) {
					console.log('    • Probe type accepted. Sending response...');
					let response =
						`<?xml version="1.0" encoding="UTF-8"?>
						<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
							xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
							xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
							xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
							<SOAP-ENV:Header>
								<wsa:MessageID>uuid:${uuid.v1()}</wsa:MessageID>
								<wsa:RelatesTo>${probeUuid}</wsa:RelatesTo>
								<wsa:To SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
								<wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
								<d:AppSequence SOAP-ENV:mustUnderstand="true" MessageNumber="${this.discoveryMessageNo}" InstanceId="1234567890"/>
							</SOAP-ENV:Header>
							<SOAP-ENV:Body>
								<d:ProbeMatches>
									<d:ProbeMatch>
										<wsa:EndpointReference>
											<wsa:Address>urn:uuid:${this.config.uuid}</wsa:Address>
										</wsa:EndpointReference>
										<d:Types>dn:NetworkVideoTransmitter</d:Types>
										<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/type/ptz onvif://www.onvif.org/hardware/Onvif onvif://www.onvif.org/name/Cardinal onvif://www.onvif.org/location/</d:Scopes>
										<d:XAddrs>http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service</d:XAddrs>
										<d:MetadataVersion>1</d:MetadataVersion>
									</d:ProbeMatch>
								</d:ProbeMatches>
							</SOAP-ENV:Body>
						</SOAP-ENV:Envelope>`;

					this.discoveryMessageNo++;
					let responseBuffer = Buffer.from(response);
					this.discoverySocket.send(responseBuffer, 0, responseBuffer.length, remote.port, remote.address, (err) => {
						if (err)
							console.error('❗ Error sending response:', err);
						else
							console.log(`    • Discovery response sent to ${remote.address}:${remote.port}`);
					});
				}
				else
				{
					console.log('⚠️ Probe type not supported — ignoring');
				}
			});
		});

		this.discoverySocket.bind({ port: 3702, address: '0.0.0.0' }, () =>
		{
			console.log('🔗 Discovery socket bound on port 3702');

			if (!this.disableMulticast)
			{
				try
				{
					this.discoverySocket.setMulticastTTL(128);
					this.discoverySocket.setMulticastLoopback(true);
					this.discoverySocket.addMembership('239.255.255.250', this.bindAddress);
					console.log(`🌐 Joined multicast group 239.255.255.250 on ${this.bindAddress}`);
				}
				catch (e)
				{
					console.warn('⚠️ Failed to join multicast group:', e.message);
				}
			}
		});
	}

	getHostname()
	{
		return this.config.hostname;
	}
}

function generateDeviceWsdl(hostname)
{
	return `<?xml version="1.0" encoding="utf-8" ?>
		<wsdl:definitions xmlns:s="http://www.w3.org/2001/XMLSchema" xmlns:i0="http://www.onvif.org/ver10/device/wsdl" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:http="http://schemas.xmlsoap.org/wsdl/http/" xmlns:mime="http://schemas.xmlsoap.org/wsdl/mime/" xmlns:tns="http://tempuri.org/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tm="http://microsoft.com/wsdl/mime/textMatching/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" targetNamespace="http://tempuri.org/">
		<wsdl:import namespace="http://www.onvif.org/ver10/device/wsdl" location="https://www.onvif.org/ver10/device/wsdl/devicemgmt.wsdl"/>
		<wsdl:service name="DeviceService">
			<wsdl:port name="Device" binding="i0:DeviceBinding">
				<soap:address location="http://${hostname}/onvif/device_service"/>
			</wsdl:port>
		</wsdl:service>
		</wsdl:definitions>`;
}

function generateMediaWsdl(hostname)
{
	return `<?xml version="1.0" encoding="utf-8" ?>
		<wsdl:definitions xmlns:s="http://www.w3.org/2001/XMLSchema" xmlns:i0="http://www.onvif.org/ver10/device/wsdl" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:http="http://schemas.xmlsoap.org/wsdl/http/" xmlns:mime="http://schemas.xmlsoap.org/wsdl/mime/" xmlns:tns="http://tempuri.org/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tm="http://microsoft.com/wsdl/mime/textMatching/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" targetNamespace="http://tempuri.org/">
		<wsdl:import namespace="http://www.onvif.org/ver10/media/wsdl" location="https://www.onvif.org/ver10/media/wsdl/media.wsdl"/>
		<wsdl:service name="MediaService">
			<wsdl:port name="Media" binding="i0:MediaBinding">
				<soap:address location="http://${hostname}/onvif/media_service"/>
			</wsdl:port>
		</wsdl:service>
		</wsdl:definitions>`;
}

function createServer(config)
{
	return new OnvifServer(config);
}

exports.createServer = createServer;