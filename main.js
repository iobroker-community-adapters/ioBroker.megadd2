/**
 *      ioBroker MegaD-2561 Adapter
 *      11'2016-2018 ausHaus
 *      2014-2021 Bluefox <dogafox@gmail.com>
 *      Lets control the MegaD-2561 over ethernet (http://www.ab-log.ru/smart-house/ethernet/megad-2561)
 *
 *
 *      The device has 36 ports inputs/outputs and DSen, I2C, 1Wire bus.
 *      To read the state of the port call
 *      http://mega_ip/sec/?pt=4&cmd=get , where sec is password (max 3 chars), 4 is port number
 *      The result will come as "ON", "OFF" or analog value for analog ports
 *
 *      To set the state call:
 *      http://mega_ip/sec/?cmd=2:1 , where sec is password (max 3 chars), 2 is port number, and 1 is the value
 *      For digital ports only 0, 1 and 2 (toggle) are allowed, for analog ports the values from 0 to 255 are allowed
 *
 *      The device can report the changes of ports to some web server in form
 *      http://ioBroker:8090/?pt=6  , where 6 is the port number
 *
 */
/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const http = require('http');
const adapterName = require('./package.json').name.split('.').pop();
let server = null;
let ports = {};
let ask1WireTemp = false;
let askEXTport = false;
let askI2Cport = false;
let connected = false;
let test = true;

let adapter;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: adapterName, // adapter name
    });

    adapter = new utils.Adapter(options);

    adapter.on('stateChange', (id, state) => {
        if (id && state && !state.ack) {
            if (!ports[id]) {
                return adapter.log.error('Unknown port ID ' + id);
            }
            if (!ports[id].common.write) {
                return adapter.log.error('Cannot write the read only port ' + id);
            }

            adapter.log.info(`try to control ${id} with ${state.val}`);

            if (state.val === 'false' || state.val === false) {
                state.val = 0;
            }
            if (state.val === 'true' || state.val === true) {
                state.val = 1;
            }

            if (parseFloat(state.val).toString() === state.val.toString()) {
                // If number => set position
                state.val = parseFloat(state.val);
                if (state.val < 0) {
                    adapter.log.warn(': invalid control value ' + state.val + '. Value must be positive');
                    state.val = 0;
                }

                if (ports[id].common.type === 'boolean' && state.val !== 0 && state.val !== 1) {
                    adapter.log.warn(': invalid control value ' + state.val + '. Value for switch must be 0/false or 1/true');
                    state.val = state.val ? 1 : 0;
                }

                if (ports[id].common.type === 'boolean') {
                    if (id.includes('_A')) {                    // DS2413
                        sendCommandToDSA(ports[id].native.port, state.val);
                    } else if (id.includes('_B')) {                    // DS2413
                        sendCommandToDSB(ports[id].native.port, state.val);
                    } else if (id.includes('_P' + ports[id].native.port + '_P')) {   // EXT
                        sendCommandToEXT(id, ports[id].native.port, ports[id].native.ext, state.val);
                    } else {
                        sendCommand(ports[id].native.port, state.val);
                    }
                } else if (id.includes('_counter')) {
                    sendCommandToCounter(ports[id].native.port, state.val);
                } else {
                    if (id.includes('_P' + ports[id].native.port + '_P')) {   // EXT
                        sendCommandToEXT(id, ports[id].native.port, ports[id].native.ext, state.val);
                    } else {
                        ports[id].native.offset = parseFloat(ports[id].native.offset || 0) || 0;
                        ports[id].native.factor = parseFloat(ports[id].native.factor || 1) || 1;

                        state.val = (state.val - ports[id].native.offset) / ports[id].native.factor;
                        state.val = Math.round(state.val);

                        sendCommand(ports[id].native.port, state.val);
                    }
                }
            }

            if (ports[id].common.type === 'string') {
                sendCommandToDisplay(ports[id].native.port, state.val);
            }
        }
    });

    adapter.on('ready', () => main());

    adapter.on('message', obj => {
        if (obj && obj.command) {
            switch (obj.command) {
                case 'send':
                    processMessage(obj.message);
                    break;

                case 'discover':
                    discoverMega(obj);
                    break;

                case 'detectPorts':
                    detectPorts(obj);
                    break;

                case 'writeConfig':
                    writeConfig(obj);
                    break;

                case 'deviceList':
                    deviceList(obj);
                    break;

                case 'i2cScan':
                    i2cScan(obj);
                    break;

                default:
                    adapter.log.warn(`Unknown message: ${JSON.stringify(obj)}`);
                    break;
            }
        }
    });

    return adapter;
}

function httpGet(options, callback, userArg) {
    http.get(options, res => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', chunk => data += chunk.toString());
        res.on('end', () => {
            if (res.statusCode !== 200) {
                adapter.log.warn(`Response code: ${res.statusCode} - ${data}`);
            } else {
                adapter.log.debug(`Response: ${data}`);
            }

            callback && callback(res.statusCode !== 200 ? res.statusCode : null, res.statusCode === 200 ? data : null, userArg);
        });
    })
        .on('error', err => callback && callback(err, null, userArg));
}

// Because the only one port is occupied by first instance, the changes to other devices will be send with messages
function processMessage(message) {
    let port;
    if (typeof message === 'string') {
        try {
            message = JSON.parse(message);
        } catch (err) {
            return adapter.log.error('Cannot parse: ' + message);
        }
    }
    port = message.pt;

    for (let i = 0; i < adapter.config.ports.length; i++) {
        if (adapter.config.ports[i].pty == 4 && adapter.config.ports[i].d == 20) {
            if (port == adapter.config.ports[i].inta) {
                port = i;
            }
        }
    }

    // Command from instance with web server
    if (adapter.config.ports[port]) {
        // If digital port
        ///if (!adapter.config.ports[port].pty && adapter.config.ports[port].m != 1) {
        if (!adapter.config.ports[port].pty && adapter.config.ports[port].misc != 1) {
            adapter.config.ports[port].value = !adapter.config.ports[port].m ? 1 : 0;
            processClick(port);
        } else if (adapter.config.ports[port].pty == 3 && (adapter.config.ports[port].d == 4 || adapter.config.ports[port].d == 6)) {
            // process iButton  or Wiegand26
            adapter.setState(adapter.config.ports[port].id, message.val, true);
        } else if (adapter.config.ports[port].pty == 4 && adapter.config.ports[port].d == 20) {
            adapter.log.debug('reported new value for port ' + port + ', request actual value');
            // process MCP230XX
            getPortStateEXT(port, processPortStateEXT);
            adapter.config.ports[message.pt].value = !adapter.config.ports[message.pt].m ? 1 : 0;
            processClick(message.pt);
        } else {
            adapter.log.debug('reported new value for port ' + port + ', request actual value');
            // Get value from analog port
            getPortState(port, processPortState);
        }
    }
}

function writeConfigOne(ip, pass, _settings, callback, port, errors) {
    if (port === undefined) {
        port = 0;
        errors = [];
    } else {
        port++;
    }
    const settings = _settings[port];
    if (!settings) {
        return callback(errors);
    }

    const parts = ip.split(':');
    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: `/${pass}/?pn=${port}`
    };

    //http://192.168.0.14/sec/?pn=1&pty=0...
    if (settings.ecmd === 'ð=') settings.ecmd = '';

    settings.pty = parseInt(settings.pty, 10) || 0;

    // Input
    if (!settings.pty) {
        settings.d = parseInt(settings.d, 10) || 0;
        settings.ecmd = settings.ecmd || '';
        settings.eth = settings.eth || '';
        options.path += `&pty=0&m=${settings.m || 0}&ecmd=${encodeURIComponent((settings.ecmd || '').trim())}&eth=${encodeURIComponent((settings.eth || '').trim())}&disp=${settings.disp || ''}`;
        if (settings.af == 1) {
            options.path += '&af=1';
        }
        if (settings.naf == 1) {
            options.path += '&naf=1';
        }
        if (settings.misc == 1) {
            options.path += '&misc=1';
        }
        if (settings.d == 1) {
            options.path += '&d=' + settings.d;
        }
    } else if (settings.pty === 1) {
        settings.d = parseInt(settings.d, 10) || 0;
        if (settings.d > 255) settings.d = 255;
        if (settings.d < 0) settings.d = 0;
        if (settings.misc == 1) settings.misc = 1;
        settings.m2 = parseInt(settings.m2, 10) || 1;

        // digital out
        if (settings.m == 0 || settings.m == 1 || settings.m == 3) {
            options.path += `&pty=1&m=${settings.m || 0}&d=${settings.d || 0}&disp=${settings.disp || ''}`;
        }
        if (settings.m == 1) {
            options.path += `&misc=${settings.misc || ''}&fr=${settings.fr || 0}`;
        }
        if (settings.misc == 1) {
            options.path += `&m2=${settings.m2}`;
        }
        if (settings.m == 2) {
            options.path += `&pty=1&m=${settings.m || 0}&disp=${settings.disp || ''}`;
        }
    } else if (settings.pty === 2) {
        // Convert misc with given factor and offset
        settings.factor = parseFloat(settings.factor || 1) || 1;
        settings.offset = parseFloat(settings.offset || 0) || 0;
        settings.misc = Math.round(((parseFloat(settings.misc) || 0) - settings.offset) / settings.factor);

        if (settings.misc > 1023) settings.misc = 1023;
        if (settings.misc < 0) settings.misc = 0;

        // ADC
        settings.ecmd = settings.ecmd || '';
        settings.eth = settings.eth || '';
        options.path += `&pty=2&m=${settings.m || 0}&misc=${settings.misc || 0}&hst=${settings.hst || 0}&ecmd=${encodeURIComponent((settings.ecmd || '').trim())}&eth=${encodeURIComponent((settings.eth || '').trim())}`;
        if (settings.af == 1) {
            options.path += '&af=1';
        }
        if (settings.naf == 1) {
            options.path += '&naf=1';
        }
    } else if (settings.pty === 3) {
        settings.ecmd = settings.ecmd || '';
        settings.eth = settings.eth || '';
        // digital sensor
        options.path += '&pty=3&d=' + (settings.d || 0);
        if (settings.d == 3) {
            options.path += `&m=${settings.m || 0}&misc=${settings.misc || 0}&hst=${settings.hst || 0}&ecmd=${encodeURIComponent((settings.ecmd || '').trim())}&eth=${encodeURIComponent((settings.eth || '').trim())}&disp=${settings.disp || ''}`;
            if (settings.af == 1) {
                options.path += '&af=1';
            }
            if (settings.naf == 1) {
                options.path += '&naf=1';
            }
        }
        if (settings.d == 4) {
            options.path += `&hst=${settings.hst || 0}&ecmd=${encodeURIComponent((settings.ecmd || '').trim())}&eth=${encodeURIComponent((settings.eth || '').trim())}`;
            if (settings.af == 1) {
                options.path += '&af=1';
            }
            if (settings.naf == 1) {
                options.path += '&naf=1';
            }
        }
        if (settings.d == 6) {
            options.path += `&m=${settings.m || 0}&misc=${settings.misc || 0}&ecmd=${encodeURIComponent((settings.ecmd || '').trim())}&eth=${encodeURIComponent((settings.eth || '').trim())}`;
            if (settings.af == 1) {
                options.path += '&af=1';
            }
            if (settings.naf == 1) {
                options.path += '&naf=1';
            }
        }
    } else if (settings.pty === 4) {
        ///if (settings.hst > 254) settings.hst = 254;
        ///if (settings.hst < 2)   settings.hst = 2;

        // I2C
        options.path += `&pty=4&m=${settings.m || 0}`;
        if (settings.m == 1) {
            options.path += `&misc=${settings.misc || 0}&d=${settings.d || 0}`;
        }
        if (settings.d == 4) {
            if (settings.hst > 254) settings.hst = 254;
            if (settings.hst < 2) settings.hst = 2;
            options.path += `&hst=${settings.hst || ''}`;
        }
        if (settings.d == 21) {
            if (settings.hst > 1526) settings.hst = 1526;
            if (settings.hst < 24) settings.hst = 24;
            options.path += `&hst=${settings.hst || ''}`;
        }
    } else {
        // NC
        options.path += '&pty=255';
    }

    adapter.log.info(`Write config for port ${port}: http://${ip}${options.path}`);

    httpGet(options, (err /*, data */) => {
        if (err) {
            errors[port] = err;
            setTimeout(() =>
                writeConfigOne(ip, pass, _settings, callback, port, errors), 1000);
        } else {
            setTimeout(() =>
                writeConfigOne(ip, pass, _settings, callback, port, errors), 1000);
        }
    });
}

function ipToBuffer(ip, buff, offset) {
    offset = ~~offset;

    let result;

    if (/^(\d{1,3}\.){3,3}\d{1,3}$/.test(ip)) {
        result = buff || Buffer.alloc(offset + 4);
        ip.split(/\./g).map(byte => result[offset++] = parseInt(byte, 10) & 0xff);
    } else if (/^[a-f0-9:]+$/.test(ip)) {
        const s = ip.split(/::/g, 2);
        const head = (s[0] || '').split(/:/g, 8);
        const tail = (s[1] || '').split(/:/g, 8);

        if (tail.length === 0) {
            // xxxx::
            while (head.length < 8) {
                head.push('0000');
            }
        } else if (head.length === 0) {
            // ::xxxx
            while (tail.length < 8) {
                tail.unshift('0000');
            }
        } else {
            // xxxx::xxxx
            while (head.length + tail.length < 8) {
                head.push('0000');
            }
        }

        result = buff || Buffer.alloc(offset + 16);
        head.concat(tail).map(word => {
            word = parseInt(word, 16);
            result[offset++] = (word >> 8) & 0xff;
            result[offset++] = word & 0xff;
        });
    } else {
        throw Error('Invalid ip address: ' + ip);
    }

    return result;
}

function ipToString(buff, offset, length) {
    offset = ~~offset;
    length = length || (buff.length - offset);

    let result = [];
    if (length === 4) {
        // IPv4
        for (let i = 0; i < length; i++) {
            result.push(buff[offset + i]);
        }
        result = result.join('.');
    } else if (length === 16) {
        // IPv6
        for (let i = 0; i < length; i += 2) {
            result.push(buff.readUInt16BE(offset + i).toString(16));
        }
        result = result.join(':');
        result = result.replace(/(^|:)0(:0)*:0(:|$)/, '$1::$3');
        result = result.replace(/:{3,4}/, '::');
    }

    return result;
}

function ipMask(addr, mask) {
    addr = ipToBuffer(addr);
    mask = ipToBuffer(mask);

    const result = Buffer.alloc(Math.max(addr.length, mask.length));

    // Same protocol - do bitwise and
    if (addr.length === mask.length) {
        for (let i = 0; i < addr.length; i++) {
            result[i] = addr[i] & mask[i];
        }
    } else if (mask.length === 4) {
        // IPv6 address and IPv4 mask
        // (Mask low bits)
        for (let i = 0; i < mask.length; i++) {
            result[i] = addr[addr.length - 4 + i] & mask[i];
        }
    } else {
        // IPv6 mask and IPv4 addr
        for (let i = 0; i < result.length - 6; i++) {
            result[i] = 0;
        }

        // ::ffff:ipv4
        result[10] = 0xff;
        result[11] = 0xff;
        for (let i = 0; i < addr.length; i++) {
            result[i + 12] = addr[i] & mask[i + 12];
        }
    }

    return ipToString(result);
}

function findIp(ip) {
    const parts = ip.split(':');
    ip = parts[0];

    if (ip === 'localhost' || ip === '127.0.0.1') {
        return '127.0.0.1';
    }

    const interfaces = require('os').networkInterfaces();

    for (const k in interfaces) {
        for (const k2 in interfaces[k]) {
            const address = interfaces[k][k2];
            if (address.family === 'IPv4' && !address.internal && address.address) {

                // Detect default subnet mask
                const num = parseInt(address.address.split('.')[0], 10);
                let netMask;
                if (num >= 192) {
                    netMask = '255.255.255.0';
                } else if (num >= 128) {
                    netMask = '255.255.0.0';
                } else {
                    netMask = '255.0.0.0';
                }

                if (ipMask(address.address, netMask) === ipMask(ip, netMask)) {
                    return address.address;
                }
            }
        }
    }
    return null;
}

function writeConfigDevice(ip, pass, config, callback) {
    //pwd: пароль для доступа к Web-интерфейсу устройства (макс. 3 байт)
    //eip: IP-адрес устройства
    //sip: IP-адрес сервера
    //sct: скрипт, который вызывается на сервере в случаях, заданных пользователем (макс. 15 байт)

    const parts = ip.split(':');
    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + pass + '/?cf=1'
    };

    if (config.eip !== undefined && config.eip !== ip) options.path += '&eip=' + config.eip;
    if (config.pwd !== undefined && config.pwd !== pass) options.path += '&pwd=' + config.pwd;

    if (config.eip === undefined && config.pwd === undefined) {
        const sip = findIp(config.eip || ip);
        if (!sip) {
            return callback(`Device with "${ip}" is not reachable from ioBroker.`);
        }
        ///options.path += '&sip=' + sip + (config.port ? ':' + config.port : '');
        options.path += '&sip=' + sip + (config.port ? ':' + config.port : ':80');
        options.path += '&sct=' + encodeURIComponent(adapter.instance + '/');
    }

    adapter.log.info('Write config for device: http://' + ip + options.path);

    httpGet(options, err /*, data */ =>
        callback(err));
}

function writeConfig(obj) {
    let ip;
    let password;
    let _ports;
    let config;
    if (obj && obj.message && typeof obj.message === 'object') {
        ip = obj.message.ip;
        password = obj.message.password;
        _ports = obj.message.ports;
        config = obj.message.config;
    } else {
        ip = obj ? obj.message : '';
        password = adapter.config.password;
        _ports = adapter.config.ports;
        config = adapter.config;
    }

    const errors = [];
    if (ip && ip !== '0.0.0.0') {
        let running = false;
        if (_ports && _ports.length) {
            running = true;
            writeConfigOne(ip, password, _ports, (err, port) => {
                setTimeout(() => {
                    if (err) {
                        errors[port] = err;
                    }
                    if (config) {
                        writeConfigDevice(ip, password, config, err => {
                            if (err) errors[20] = err;
                            obj.callback && adapter.sendTo(obj.from, obj.command, {error: errors}, obj.callback);
                        });
                    } else {
                        obj.callback && adapter.sendTo(obj.from, obj.command, {error: errors}, obj.callback);
                    }
                }, 1000);
            });
        } else if (config) {
            running = true;
            writeConfigDevice(ip, password, config, err => {
                if (err) {
                    errors[20] = err;
                }
                obj.callback && adapter.sendTo(obj.from, obj.command, {error: errors}, obj.callback);
            });
        }

        if (!running) {
            obj.callback && adapter.sendTo(obj.from, obj.command, {error: 'no ports and no config'}, obj.callback);
        }
    } else {
        obj.callback && adapter.sendTo(obj.from, obj.command, {error: 'invalid address'}, obj.callback);
    }
}

function detectPortConfig(ip, pass, length, callback, port, result) {
    if (port === undefined) {
        port = 0;
        result = [];
    } else {
        port++;
        if (port >= length) {
            return callback(result);
        }
    }

    const parts = ip.split(':');
    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + pass + '/?pt=' + port
    };

    adapter.log.info(`read config from port: http://${ip}${options.path}`);

    httpGet(options, (err, data) => {
        if (err) {
            adapter.log.error(err);
            detectPortConfig(ip, pass, length, callback, port, result);
        } else {
            const settings = {};
            // Analyse answer
            let inputs = data.match(/<input [^>]+>/g);

            if (inputs) {
                for (let i = 0; i < inputs.length; i++) {
                    const args = inputs[i].match(/(\w+)=([^<> ]+)/g);
                    if (args) {
                        const iSettings = {};
                        for (let a = 0; a < args.length; a++) {
                            const parts = args[a].split('=');
                            iSettings[parts[0]] = parts[1].replace(/^"/, '').replace(/"$/, '');
                        }

                        if (iSettings.name) {
                            settings[iSettings.name] = (iSettings.value === undefined) ? '' : iSettings.value;
                            if (iSettings.type === 'checkbox' && inputs[i].indexOf('checked') === -1) {
                                settings[iSettings.name] = (!settings[iSettings.name]) ? 1 : 0;
                            }
                        }
                    }
                }
            }
            inputs = data.match(/<select .+?<\/select>/g);
            if (inputs) {
                for (let i = 0; i < inputs.length; i++) {
                    const name = inputs[i].match(/name=(\w+)/);
                    if (name) {
                        const consts = inputs[i].match(/<option value=(\d+) selected>/);
                        if (consts) {
                            settings[name[1]] = consts[1];
                        } else {
                            settings[name[1]] = 0;
                        }
                    }
                }
            }

            if (settings.pty === undefined) {
                if (data.indexOf('>Type In<') !== -1) {
                    settings.pty = 0;
                } else if (data.indexOf('>Type Out<') !== -1) {
                    settings.pty = 1;
                }
            } else {
                settings.pty = parseInt(settings.pty, 10);
            }

            if (settings.m !== undefined) settings.m = parseInt(settings.m, 10);
            if (settings.d !== undefined) settings.d = parseInt(settings.d, 10);
            if (settings.pn !== undefined) settings.pn = parseInt(settings.pn, 10);
            if (settings.naf !== undefined) settings.naf = parseInt(settings.naf, 10);
            if (settings.fr !== undefined) settings.fr = parseInt(settings.fr, 10);
            if (settings.m2 !== undefined) settings.m2 = parseInt(settings.m2, 10);
            if (settings.ecmd === 'ð=') settings.ecmd = '';

            if (settings.pty == 4 && settings.d == 20) {    //EXT
                let ext = data.match(/<br>[^>]+<form/g);
                if (ext) {
                    ext = data.split(';');
                    for (const e in ext) ;
                    e++;
                    settings.ext = parseInt(e, 10);
                }
            }

            result[port] = settings;
            adapter.log.debug(`Response: ${data}`);
            detectPortConfig(ip, pass, length, callback, port, result);
        }
    });
}

function detectDeviceConfig(ip, pass, callback) {
    const parts = ip.split(':');
    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: `/${pass}/?cf=1`
    };

    adapter.log.info(`read config from port: http://${ip}${options.path}`);

    httpGet(options, (err, data) => {
        if (err) {
            callback(err);
        } else {
            // parse config
            // Analyse answer
            let inputs = data.match(/<input [^>]+>/g);
            let i;
            const settings = {};

            if (inputs) {
                for (let i = 0; i < inputs.length; i++) {
                    const args = inputs[i].match(/(\w+)=([^<> ]+)/g);
                    if (args) {
                        const iSettings = {};
                        for (let a = 0; a < args.length; a++) {
                            const parts = args[a].split('=');
                            iSettings[parts[0]] = parts[1].replace(/^"/, '').replace(/"$/, '');
                        }

                        if (iSettings.name) {
                            settings[iSettings.name] = (iSettings.value === undefined) ? '' : iSettings.value;
                            if (iSettings.type === 'checkbox' && inputs[i].indexOf('checked') === -1) {
                                settings[iSettings.name] = (!settings[iSettings.name]) ? 1 : 0;
                            }
                        }
                    }
                }
            }
            inputs = data.match(/<select .+?<\/select>/g);
            if (inputs) {
                for (i = 0; i < inputs.length; i++) {
                    const name = inputs[i].match(/name=(\w+)/);
                    if (name) {
                        const consts = inputs[i].match(/<option value=(\d+) selected>/);
                        if (consts) {
                            settings[name[1]] = consts[1];
                        } else {
                            settings[name[1]] = 0;
                        }
                    }
                }
            }
            callback(null, settings);
        }
    });
}

// Message is IP address
function detectPorts(obj) {
    let ip;
    let password;
    if (obj && obj.message && typeof obj.message === 'object') {
        ip = obj.message.ip;
        password = obj.message.password;
    } else {
        ip = obj ? obj.message : '';
        password = adapter.config.password;
    }
    if (ip && ip !== '0.0.0.0') {
        getPortsState(ip, password, (err, response) => {
            if (err || !response) {
                obj.callback && adapter.sendTo(obj.from, obj.command, {error: err, response: response}, obj.callback);
                return;
            }
            const parts = response.split(';');
            detectPortConfig(ip, password, parts.length, result =>
                detectDeviceConfig(ip, password, (error, devConfig) => {
                    obj.callback && adapter.sendTo(obj.from, obj.command, {
                        error: err,
                        response: response,
                        ports: result,
                        config: devConfig
                    }, obj.callback);
                }));
        });
    } else {
        obj.callback && adapter.sendTo(obj.from, obj.command, {error: 'invalid address'}, obj.callback);
    }
}

function deviceList(obj) {
    //http://192.168.1.14/sec/?pt=33&cmd=list
    const port = obj.message.index;
    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + adapter.config.password + '/?pt=' + port + '&cmd=list'
    };

    adapter.log.debug('getDeviceList http://' + options.host + options.path);

    httpGet(options, (err, data) => {
        if (err) {
            deviceList(obj);
        } else {
            if (data === 'busy') {
                deviceList(obj);
            } else {
                //const list = data.split(';');
                const inputs = data.replace(/:(\D*[0-9.]+)/g, '');
                obj.callback && adapter.sendTo(obj.from, obj.command, {error: null, devices: inputs}, obj.callback);
            }
        }
    });
}

function i2cScan(obj) {
    //http://192.168.1.14/sec/?pt=11&cmd=scan
    const port = obj.message.index;
    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: `/${adapter.config.password}/?pt=${port}&cmd=scan`
    };

    adapter.log.debug(`getI2CScan http://${options.host}${options.path}`);

    httpGet(options, (err, data) => {
        if (err) {
            i2cScan(obj);
        } else {
            const inputs = data.match(/([^a-z0-9> ]\w+)[^<br>]+/g);
            obj.callback && adapter.sendTo(obj.from, obj.command, {error: null, devices: inputs}, obj.callback);
        }
    });
}

function discoverMegaOnIP(ip, callback) {
    const nums = ip.split('.');
    nums[3] = 255;
    ip = nums.join('.');

    const dgram = require('dgram');
    const message = Buffer.from([0xAA, 0, 12]);
    const client = dgram.createSocket('udp4');
    client.on('error', err =>
        adapter.log.error(err));

    client.bind(42000, () =>
        client.setBroadcast(true));

    client.on('message', (msg, rinfo) => {
        if (msg[0] == 0xAA) {
            result.push(rinfo.address);
        }

        console.log('Received %d bytes from %s:%d\n',
            msg.length, rinfo.address, rinfo.port);
    });
    client.send(message, 0, message.length, 52000, ip, err =>
        console.log(`Discover sent to ${ip}`));

    const result = [];

    setTimeout(() => {
        client.close();
        callback(result);
    }, 2000);

}

function discoverMega(obj) {
    const interfaces = require('os').networkInterfaces();
    const result = [];
    let count = 0;
    for (const k in interfaces) {
        for (const k2 in interfaces[k]) {
            const address = interfaces[k][k2];
            if (address.family === 'IPv4' && !address.internal && address.address) {
                count++;
                discoverMegaOnIP(address.address, _result => {
                    if (_result && _result.length) {
                        for (let i = 0; i < _result.length; i++) {
                            result.push(_result[i]);
                        }
                    }
                    if (!--count) {
                        obj.callback && adapter.sendTo(obj.from, obj.command, {
                            error: null,
                            devices: result
                        }, obj.callback);
                    }
                });
            }
        }
    }

    !count && obj.callback && adapter.sendTo(obj.from, obj.command, {error: null, devices: []}, obj.callback);
}

// Get State of ONE port
function getPortState(port, callback) {
    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: `/${adapter.config.password}/?pt=${port}&cmd=get`
    };

    adapter.log.debug(`getPortState http://${options.host}${options.path}`);

    httpGet(options, (err, data) => {
        if (err) {
            callback && callback(err);
        } else {
            callback && callback(port, data);
        }
    });
}

function getPortStateI2C(port, callback) {
    // 0x78 - SSD1306
    // 0x80 - HTU21D/PCA9685
    // влажности (0x80 - HTU21D/Si7021) http://192.168.0.14/sec/?pt=35&scl=34&i2c_dev=htu21d
    // температуры (0x80 - HTU21D)      http://192.168.0.14/sec/?pt=35&scl=34&i2c_dev=htu21d&i2c_par=1
    // освещенности (0x94 - MAX44009)   http://192.168.0.14/sec/?pt=30&scl=31&i2c_dev=max44009
    // освещенности (0x46 - BH1750)     http://192.168.0.14/sec/?pt=30&scl=31&i2c_dev=bh1750
    // освещенности (0x51 - TSL2591 0x53 ???)    http://192.168.0.14/sec/?pt=30&scl=31&i2c_dev=tsl2591
    // атмосферного давления (BMP180) http://192.168.0.14/sec/?pt=30&scl=31&i2c_dev=bmp180
    // температуры (BMP180)      http://192.168.0.14/sec/?pt=31&scl=30&i2c_dev=bmp180&i2c_par=1
    // атмосферного давления (BMP280/BME280) http://192.168.0.14/sec/?pt=30&scl=31&i2c_dev=bmx280
    // температуры (BMP280/BME280) http://192.168.0.14/sec/?pt=31&scl=30&i2c_dev=bmx280&i2c_par=1
    // влажности (0xee - BME280) http://192.168.0.14/sec/?pt=31&scl=30&i2c_dev=bmx280&i2c_par=2
    // 4-х канального АЦП (0x90 - ADS1115) http://192.168.0.14/sec/?pt=35&scl=34&i2c_dev=ads1115&i2c_par=0
    //                                     http://192.168.0.14/sec/?pt=35&scl=34&i2c_dev=ads1115&i2c_par=1
    //                                     http://192.168.0.14/sec/?pt=35&scl=34&i2c_dev=ads1115&i2c_par=2
    //                                     http://192.168.0.14/sec/?pt=35&scl=34&i2c_dev=ads1115&i2c_par=3

    const config = adapter.config.ports[port];
    if (config.scan !== undefined) {
        const sensor = config.scan.split(',');
        let data = '';

        for (let i = 0; i < sensor.length; ++i) {
            if (sensor[i].indexOf('BH1750') !== -1) {
                data = [{name: 'light', dev: 'bh1750'}];
            }
            if (sensor[i].indexOf('TSL2591') !== -1) {
                data = [{name: 'light', dev: 'tsl2591'}];
            }
            if (sensor[i].indexOf('MAX44009') !== -1) {
                data = [{name: 'light', dev: 'max44009'}];
            }
            if (sensor[i].indexOf('HTU21D') !== -1) {
                data = [{name: 'humidity', dev: 'htu21d'}, {name: 'temperature', dev: 'htu21d&i2c_par=1'}];
            }
            if (sensor[i].indexOf('BMP180') !== -1) {
                data = [{name: 'pressure', dev: 'bmp180'}, {name: 'temperature', dev: 'bmp180&i2c_par=1'}];
            }
            if (sensor[i].indexOf('BMX280') !== -1) {
                data = [{name: 'pressure', dev: 'bmx280'}, {
                    name: 'temperature',
                    dev: 'bmx280&i2c_par=1'
                }, {name: 'humidity', dev: 'bmx280&i2c_par=2'}];
            }
            if (sensor[i].indexOf('ADS1115') !== -1) {
                data = [{name: '0', dev: 'ads1115&i2c_par=0'}, {name: '1', dev: 'ads1115&i2c_par=1'}, {
                    name: '2',
                    dev: 'ads1115&i2c_par=2'
                }, {name: '3', dev: 'ads1115&i2c_par=3'}];
            }

            for (let j = 0; j < data.length; ++j) {
                let test = '';

                if (config.d === 1) test = 'HTU21D';
                if (config.d === 2) test = 'BH1750';
                if (config.d === 3) test = 'TSL2591';
                if (config.d === 4) test = 'SSD1306';
                if (config.d === 5) test = 'BMP180';
                if (config.d === 6) test = 'BMx280';
                if (config.d === 7) test = 'MAX44009';
                if (config.d === 20) test = 'MCP230XX';
                if (config.d === 21) test = 'PCA9685';

                if (sensor[i] === test) {
                    continue;
                }

                const dev = data[j].dev;
                const id = sensor[i] + '_' + data[j].name;

                callback(port, id, dev);
            }
        }
    }
}

// Get state of EXT ports
function getPortStateEXT(port, callback) {
    //http://192.168.1.14/sec/?pt=4&cmd=get
    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: `/${adapter.config.password}/?pt=${port}&cmd=get`
    };

    adapter.log.debug(`getPortStateEXT http://${options.host}${options.path}`);

    httpGet(options, (err, data) =>
        callback(port, data));
}

// Get state of 1WBUS ports
function getPortStateW(port, callback) {
    //http://192.168.1.14/sec/?pt=33&cmd=list
    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + adapter.config.password + '/?pt=' + port + '&cmd=list'
    };

    adapter.log.debug('getPortStateW http://' + options.host + options.path);

    httpGet(options, (err, data) => {
        callback(port, data);
    });
}

// Get state of ALL ports
function getPortsState(ip, password, callback) {
    if (typeof ip === 'function') {
        callback = ip;
        ip = null;
    }
    if (typeof password === 'function') {
        callback = password;
        password = null;
    }
    password = (password === undefined || password === null) ? adapter.config.password : password;
    ip = ip || adapter.config.ip;

    const parts = ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + password + '/?cmd=all'
    };

    adapter.log.debug('getPortState http://' + options.host + options.path);

    httpGet(options, (err, data) => {
        callback && callback(err, data);
    });
}

function processClick(port) {
    const config = adapter.config.ports[port];

    // If press_long
    ///if (config.m == 1 && config.long) {
    if ((config.m == 1 || config.misc == 1) && config.long) {
        // Detect EDGE
        if (config.oldValue !== undefined && config.oldValue !== null && config.oldValue !== config.value) {
            adapter.log.debug('new state detected on port [' + port + ']: ' + config.value);

            // If pressed
            if (config.value) {
                // If no timer running
                if (!config.longTimer) {
                    adapter.log.debug('start long click detection on [' + port + ']: ' + config.value);
                    // Try to detect long click
                    config.longTimer = setTimeout(() => {
                        config.longTimer = null;
                        config.longDone = true;

                        adapter.log.debug('Generate LONG press on port ' + port);

                        adapter.setState(config.id + '_long', true, true);

                    }, adapter.config.longPress);
                } else {
                    adapter.log.warn('long timer runs, but state change happens on [' + port + ']: ' + config.value);
                }
            } else {
                // If released
                // If timer for double running => stop it
                if (config.longTimer) {
                    adapter.log.debug('stop long click detection on [' + port + ']: ' + config.value);
                    clearTimeout(config.longTimer);
                    config.longTimer = null;
                }

                // If long click generated => clear flag and do nothing, elsewise generate normal click
                if (!config.longDone) {
                    adapter.log.debug('detected short click on port [' + port + ']: ' + config.value);

                    if (config.double && adapter.config.doublePress) {
                        detectDoubleClick(port);
                    } else {
                        adapter.setState(config.id, true, true);
                        // Set automatically the state of the port to false after 100ms
                        setTimeout(() =>
                            adapter.setState(config.id, false, true), 100);
                    }
                } else {
                    // Set to false
                    adapter.log.debug('Remove LONG press on port ' + port);
                    adapter.setState(config.id + '_long', false, true);

                    adapter.log.debug('clear the double click flag on port [' + port + ']: ' + config.value);
                    config.longDone = false;
                }
            }
        } else {
            adapter.log.debug('ignore state on port [' + port + ']: ' + config.value + ' (because the same)');
        }
    } else {
        adapter.log.debug('detected new state on port [' + port + ']: ' + config.value);
        triggerShortPress(port);
    }
}

function detectDoubleClick(port) {
    const config = adapter.config.ports[port];

    if (config.double && adapter.config.doublePress) {

        if (config.doubleTimer) {
            clearTimeout(config.doubleTimer);
            config.doubleTimer = null;
            adapter.log.debug('Generate double click on port ' + port);
            // Generate double click
            adapter.setState(config.id + '_double', true, true);

            // Set automatically the state of the port to false after 100ms
            setTimeout(() =>
                adapter.setState(config.id + '_double', false, true), 100);

        } else {

            adapter.log.debug('Start timer for ' + adapter.config.doublePress + 'ms to detect double click on ' + port);

            config.doubleTimer = setTimeout(() => {
                adapter.log.debug('Generate short click on port ' + port);
                // Generate single click
                config.doubleTimer = null;
                adapter.setState(config.id, true, true);
                // Set automatically the state of the port to false after 100ms
                setTimeout(() =>
                    adapter.setState(config.id, false, true), 100);
            }, adapter.config.doublePress);

        }
    }
}

function triggerShortPress(port) {
    const config = adapter.config.ports[port];

    if (config.double && adapter.config.doublePress) {
        // if not first read
        if (config.oldValue === undefined || config.oldValue === null) return;

        if (!config.value) {
            adapter.setState(config.id, false, true);
            return;
        }

        detectDoubleClick(port);
    } else {
        ///if (config.m != 1) {
        if (config.misc != 1) {
            // if not first read
            if (config.oldValue === undefined || config.oldValue === null) return;
            adapter.log.debug('reported new state for port ' + port + ' - true');

            adapter.setState(config.id, true, true);

            // Set automatically the state of the port to false after 100ms
            setTimeout(() => {
                adapter.log.debug('set state for port ' + port + ' back to false');
                config.value = 0;
                adapter.setState(config.id, false, true);
            }, 100);
        } else {
            adapter.setState(config.id, !!config.value, true);
        }
    }
}

function processPortState(_port, value) {
    const _ports = adapter.config.ports;
    let q = 0;

    if (!_ports[_port]) {
        // No configuration found
        adapter.log.warn('Unknown port: ' + _port);
        return;
    }

    if (value !== null) {
        let secondary = null;
        let f;
        // Value can be OFF/5 or 27/0 or 27 or ON  or DS2413 ON/OFF
        if (typeof value === 'string') {
            const t = value.split('/');
            const m = value.match(/temp:([0-9.-]+)/);
            if (m) {
                if (value.match(/press:([0-9.]+)/)) {
                    secondary = value.match(/press:([0-9.]+)/);
                } else
                    secondary = value.match(/hum:([0-9.]+)/);
                if (secondary) secondary = parseFloat(secondary[1]);
                value = m[1];
            } else {
                value = t[0];
            }

            if (t[1] !== undefined && secondary === null) { // counter
                secondary = parseInt(t[1], 10);
            }
            if (t[1] === 'OFF') {  // DS2413
                secondary = 0;
            } else if (t[1] === 'ON') {
                secondary = 1;
            } else if (t[1] === 'NA') {
                secondary = 0;
                q = 0x82; // DS2413 not connected
            }

            if (value === 'OFF') {
                value = 0;
            } else if (value === 'ON') {
                value = 1;
            } else if (value === 'NA') {
                value = 0;
                q = 0x82; // sensor not connected
            } else {
                value = parseFloat(value) || 0;
            }
        }

        // If status changed
        if (value !== _ports[_port].value || _ports[_port].q !== q || (secondary !== null && _ports[_port].secondary != secondary)) {
            _ports[_port].oldValue = _ports[_port].value;

            ///if (!_ports[_port].pty) {
            if (_ports[_port].pty == 0) {
                if (value !== _ports[_port].value || _ports[_port].q !== q) {
                    _ports[_port].value = value;
                    processClick(_port);
                }
                if (secondary !== null && (_ports[_port].secondary != secondary || _ports[_port].q !== q)) {
                    adapter.setState(_ports[_port].id + '_counter', {val: secondary, ack: true, q: q});
                }
            } else if (_ports[_port].pty == 2) {
                f = value * _ports[_port].factor + _ports[_port].offset;
                value = Math.round(value * 1000) / 1000;

                adapter.log.debug('detected new value on port [' + _port + ']: ' + value + ', calc state ' + f);
                adapter.setState(_ports[_port].id, {val: f, ack: true, q: q});
            } else if (_ports[_port].pty == 3) {
                if (_ports[_port].value !== value || _ports[_port].q !== q) {
                    adapter.log.debug('detected new value on port [' + _port + ']: ' + value);
                    adapter.setState(_ports[_port].id, {val: value, ack: true, q: q});
                }
                if (secondary !== null && (_ports[_port].secondary != secondary || _ports[_port].q !== q)) {
                    adapter.log.debug('detected new value on port [' + _port + '_humidity' + ']: ' + value);
                    adapter.setState(_ports[_port].id + '_humidity', {val: secondary, ack: true, q: q});
                }
            } else if (_ports[_port].pty == 4 && _ports[_port].m == 1 && _ports[_port].d !== 4) {
                if (_ports[_port].value !== value || _ports[_port].q !== q) {
                    adapter.log.debug('detected new value on port [' + _port + ']: ' + value);
                    adapter.setState(_ports[_port].id, {val: value, ack: true, q: q});
                }
                if (secondary !== null && (_ports[_port].secondary != secondary || _ports[_port].q !== q)) {
                    if (_ports[_port].d == 5 || _ports[_port].d == 6) {
                        adapter.log.debug('detected new value on port [' + _port + '_pressure' + ']: ' + secondary);
                        adapter.setState(_ports[_port].id + '_pressure', {val: secondary, ack: true, q: q});
                    } else
                        adapter.log.debug('detected new value on port [' + _port + '_humidity' + ']: ' + secondary);
                    adapter.setState(_ports[_port].id + '_humidity', {val: secondary, ack: true, q: q});
                }
            } else if (_ports[_port].pty == 1) {
                if (_ports[_port].m == 1) {
                    //f = value * _ports[_port].factor + _ports[_port].offset;
                    value = Math.round(value * 1000) / 1000;

                    adapter.log.debug('detected new value on port [' + _port + ']: ' + value);
                    adapter.setState(_ports[_port].id, {val: value, ack: true, q: q});
                }
                if (_ports[_port].m == 0 || _ports[_port].m == 3) {
                    adapter.log.debug('detected new value on port [' + _port + ']: ' + (!!value));
                    adapter.setState(_ports[_port].id, {val: !!value, ack: true, q: q});
                }
                if (_ports[_port].m == 2) {  // DS2413
                    if (value !== _ports[_port].value || _ports[_port].q !== q) {
                        adapter.log.debug('detected new value on port [' + _port + '_A' + ']: ' + (!!value));
                        adapter.setState(_ports[_port].id + '_A', {val: !!value, ack: true, q: q});
                    }
                    if (secondary !== null && (_ports[_port].secondary != secondary || _ports[_port].q !== q)) {
                        adapter.log.debug('detected new value on port [' + _port + '_B' + ']: ' + (secondary ? true : false));
                        adapter.setState(_ports[_port].id + '_B', {val: secondary ? true : false, ack: true, q: q});
                    }
                }
            }

            _ports[_port].value = value;
            _ports[_port].q = q;
            if (secondary !== null) _ports[_port].secondary = secondary;
        }
    }
}

function processPortStateW(_port, value) {      //1Wire
    const _ports = adapter.config.ports;
    const q = 0;

    if (!_ports[_port]) {
        // No configuration found
        adapter.log.warn('Unknown port: ' + _port);
        return;
    }

    if (value && typeof value === 'string') {
        // Value can be 30c5b8000000:27.50;32c5b8000000:28.81;31c5b8000000:27.43.......
        const list = value.split(';');
        const sensor = 0;
        for (let i = 0; i < list.length; ++i) {
            let val = list[i + sensor];
            const id = val.split(':');
            const m = val.match(/:(\D*[0-9.]+)/);
            if (m) {
                val = parseFloat(m[1]);
                // If status changed
                processPortStateWstate(_port, id[0], val);
                /* if (val !== _ports[_port].value || _ports[_port].q !== q) {
                    _ports[_port].oldValue = _ports[_port].value;
                    if (_ports[_port].pty == 3 && _ports[_port].d == 5) {
                        adapter.log.debug('detected new value on port [' + _port + '_' + id[0] + ']: ' + val);
                        adapter.setState(_ports[_port].id + '_' + id[0], {val: val, ack: true, q: q});
                    }
                    _ports[_port].value = val;
                    _ports[_port].q     = q;
                } */
            }
        }
    }
}

function processPortStateWstate(_port, id, value) {      //1Wire
    const _ports = adapter.config.ports;
    const q = 0;

    if (test === true) {
        adapter.setState(_ports[_port].id + '_' + id, {val: undefined, ack: true, q: undefined});
    }

    if (value) {
        adapter.getState(_ports[_port].id + '_' + id, (err, state) => {
            if (test !== true) {
                state.val = state.val;
            } else {
                state.val = undefined;
            }
            // If status changed
            if (value !== state.val || q !== state.q) {
                if (_ports[_port].pty == 3 && _ports[_port].d == 5) {
                    adapter.log.debug('detected new value on port [' + _port + '_' + id + ']: ' + value);
                    adapter.setState(_ports[_port].id + '_' + id, {val: value, ack: true, q: q});
                }
            }
        });
    }
    setTimeout(() =>
        test = false, 2500);
}

function processPortStateEXTport(port, ext, value) {     //EXT
    const _ports = adapter.config.ports;
    const q = 0;

    if (test === true) {
        adapter.setState(_ports[port].id + '_P' + ext, {val: undefined, ack: true, q: undefined});
    }

    adapter.getState(_ports[port].id + '_P' + ext, (err, state) => {
        if (test !== true) {
            if (state.val === 'false' || state.val === false) {
                state.val = 0;
            }
            if (state.val === 'true' || state.val === true) {
                state.val = 1;
            }
        } else {
            state.val = undefined;
        }
        if (typeof value === 'string') {
            if (value === 'OFF') {
                value = 0;
            } else if (value === 'ON') {
                value = 1;
            } else {
                value = parseFloat(value) || 0;
            }
        }
        // If status changed
        if (value !== state.val || q !== state.q) {
            if (_ports[port].pty == 4 && _ports[port].d == 20) {
                adapter.log.debug('detected new value on port [' + port + '_P' + ext + ']: ' + (!!value));
                adapter.setState(_ports[port].id + '_P' + ext, {val: !!value, ack: true, q: q});
            }
            if (_ports[port].pty == 4 && _ports[port].d == 21) {
                adapter.log.debug('detected new value on port [' + port + '_P' + ext + ']: ' + value);
                adapter.setState(_ports[port].id + '_P' + ext, {val: value, ack: true, q: q});
            }
        }
    });
}

function processPortStateEXT(_port, value) {   //MCP23008 - 8port MCP23017 - 16port
    const _ports = adapter.config.ports;
    const q = 0;

    if (!_ports[_port]) {
        // No configuration found
        adapter.log.warn('Unknown port: ' + _port);
        return;
    }

    if (typeof value === 'string') {
        // Value can be OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF or OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF;OFF
        const args = value.split(';');
        for (let i = 0; i < args.length; ++i) {
            const val = args[i];
            processPortStateEXTport(_port, i, val);
        }
    }
    setTimeout(() =>
            test = false
        , 2500);
}

function processPortStateI2C(_port, id, dev) {
    const parts = adapter.config.ip.split(':');
    const config = adapter.config.ports[_port];
    const _ports = adapter.config.ports;
    const scl = config.misc;
    const q = 0;

    if (test === true) {
        adapter.setState(_ports[_port].id + '_' + id, {val: undefined, ack: true, q: undefined});
    }

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + 'sec' + '/?pt=' + _port + '&scl=' + scl + '&i2c_dev=' + dev
    };

    adapter.log.debug('getPortStateI2C http://' + options.host + options.path);

    httpGet(options, (err, value) => {
        if (value) {
            adapter.getState(_ports[_port].id + '_' + id, (err, state) => {
                if (test !== true) {
                    state.val = state.val;
                } else {
                    state.val = undefined;
                }
                // If status changed
                if (value !== state.val || q !== state.q) {
                    if (_ports[_port].pty == 4 && _ports[_port].m == 1) {
                        adapter.log.debug('detected new value on port [' + _port + '_' + id + ']: ' + value);
                        adapter.setState(_ports[_port].id + '_' + id, {val: value, ack: true, q: q});
                    }
                }
            });
        }
    });
    setTimeout(() =>
        test = false, 2500);
}

function pollStatus(dev) {
    /*for (const port = 0; port < adapter.config.ports.length; port++) {
        getPortState(port, processPortState);
    }*/
    getPortsState((err, data) => {
        if (err) {
            adapter.log.warn(err);
            if (connected) {
                connected = false;
                adapter.log.warn('Device "' + adapter.config.ip + '" is disconnected');
                adapter.setState('info.connection', false, true);
            }
        } else {
            if (!connected) {
                adapter.log.info('Device "' + adapter.config.ip + '" is connected');
                connected = true;
                adapter.setState('info.connection', true, true);
            }
        }

        if (data) {
            const _ports = data.split(';');
            let p;
            for (p = 0; p < _ports.length; p++) {
                // process
                if (!adapter.config.ports[p] || (adapter.config.ports[p].pty == 3 && adapter.config.ports[p].d == 5)) continue;
                if (!adapter.config.ports[p] || (adapter.config.ports[p].pty == 4 && (adapter.config.ports[p].d == 20 || adapter.config.ports[p].d == 21))) continue;
                processPortState(p, _ports[p]);
            }
            // process 1Wire
            if (ask1WireTemp) {
                for (let po = 0; po < adapter.config.ports.length; po++) {
                    if (adapter.config.ports[po] && adapter.config.ports[po].pty == 3 && adapter.config.ports[po].d == 5) {
                        getPortStateW(po, processPortStateW);
                    }
                }
            }
            // process MCP230XX and PCA9685 port
            if (askEXTport) {
                for (let po = 0; po < adapter.config.ports.length; po++) {
                    if (adapter.config.ports[po] && adapter.config.ports[po].pty == 4 && (adapter.config.ports[po].d == 20 || adapter.config.ports[po].d == 21)) {
                        getPortStateEXT(po, processPortStateEXT);
                    }
                }
            }
            // process I2C and ANY port
            if (askI2Cport) {
                for (let po = 0; po < adapter.config.ports.length; po++) {
                    if (adapter.config.ports[po] && adapter.config.ports[po].pty == 4 && adapter.config.ports[po].m == 1) {
                        getPortStateI2C(po, processPortStateI2C);
                    }
                }
            }
        }
    });
}

// Process http://ioBroker:80/instance/?pt=6
function restApi(req, res) {
    const values = {};
    let url = req.url;
    const pos = url.indexOf('?');

    if (pos !== -1) {
        const arr = url.substring(pos + 1).split('&');
        url = url.substring(0, pos);

        for (let i = 0; i < arr.length; i++) {
            arr[i] = arr[i].split('=');
            values[arr[i][0]] = (arr[i][1] === undefined) ? null : arr[i][1];
        }
        if (values.prettyPrint !== undefined) {
            if (values.prettyPrint === 'false') values.prettyPrint = false;
            if (values.prettyPrint === null) values.prettyPrint = true;
        }
        // Default value for wait
        if (values.wait === null) values.wait = 2000;
    }

    const parts = url.split('/');
    const device = parts[1];

    if (!device || (device !== adapter.instance && (!adapter.config.name || device !== adapter.config.name))) {
        if (device && values.pt !== undefined) {
            // Try to find name of the instance
            if (parseInt(device, 10) == device) {
                ///if (values.ib)
                adapter.sendTo('megadd2.' + device, 'send', {pt: parseInt(values.pt, 10), val: values.ib});
                ///if (values.wg)
                ///adapter.sendTo('megadd.' + device, 'send', {pt: parseInt(values.pt, 10), val: values.wg});
                res.writeHead(200, {'Content-Type': 'text/html'});
                res.end('OK', 'utf8');
            } else {
                // read all instances of megaD
                adapter.getForeignObjects('system.adapter.megadd2.*', 'instance', (err, arr) => {
                    if (arr) {
                        for (const id in arr) {
                            if (arr[id].native.name === device) {
                                ///if (values.ib)
                                adapter.sendTo(id, 'send', {pt: parseInt(values.pt, 10), val: values.ib});
                                ///if (values.wg)
                                ///adapter.sendTo(id, 'send', {pt: parseInt(values.pt, 10), val: values.wg});
                                res.writeHead(200, {'Content-Type': 'text/html'});
                                res.end('OK', 'utf8');
                                return;
                            }
                        }
                    }

                    res.writeHead(500);
                    res.end('Cannot find ' + device);
                });
            }
        } else {
            res.writeHead(500);
            res.end('Error: unknown device name "' + device + '"');
        }
        return;
    }

    if (values.pt !== undefined) {
        const _port = parseInt(values.pt, 10);

        if (adapter.config.ports[_port]) {
            // If digital port
            if (!adapter.config.ports[_port].pty && adapter.config.ports[_port].m != 1) {
                ////if (adapter.config.ports[_port].pty == 0 && adapter.config.ports[_port].misc != 1) {
                adapter.config.ports[_port].oldValue = adapter.config.ports[_port].value;
                adapter.config.ports[_port].value = !adapter.config.ports[_port].m ? 1 : 0;
                processClick(_port);
            } else if (adapter.config.ports[_port].pty == 3 && adapter.config.ports[_port].d == 4) {
                // process iButton
                adapter.setState(adapter.config.ports[_port].id, values.ib, true);
            } else if (adapter.config.ports[_port].pty == 3 && adapter.config.ports[_port].d == 6) {
                // process WG-26
                adapter.setState(adapter.config.ports[_port].id, values.wg, true);
            } else {
                adapter.log.debug('reported new value for port ' + _port + ', request actual value');
                // Get value from analog port
                getPortState(_port, processPortState);
            }

            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end('OK', 'utf8');

            return;
        } else {
            res.writeHead(500);
            res.end('Error: port "' + _port + '". Not configured', 'utf8');
            return;
        }
    }
    res.writeHead(500);
    res.end(`Error: invalid input "${req.url}". Expected /${adapter.config.name || adapter.instance}/?pt=X`, 'utf8');
}

function sendCommand(port, value) {
    const data = `cmd=${port}:${value}`;

    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + adapter.config.password + '/?' + data
    };
    adapter.log.debug(`Send command "${data}" to ${adapter.config.ip}`);

    // Set up the request
    httpGet(options, (err /* , data */) => {
        if (adapter.config.ports[port]) {
            // Set state only if positive response from megaD
            if (adapter.config.ports[port].m == 0) {
                adapter.setState(adapter.config.ports[port].id, !!value, true);
            }
            if (adapter.config.ports[port].m == 1) {
                let f = value * adapter.config.ports[port].factor + adapter.config.ports[port].offset;
                f = Math.round(f * 1000) / 1000;
                adapter.setState(adapter.config.ports[port].id, f, true);
            }
            if (adapter.config.ports[port].pty == 4 && adapter.config.ports[port].d == 4) {
                adapter.setState(adapter.config.ports[port].id, value, true);
            }
        } else {
            adapter.log.warn('Unknown port ' + port);
        }
    });
}

function sendCommandToDSA(port, value) {          //DS2413 port A
    //http://192.168.1.14/sec/?cmd=7A:0 or &cmd=7A:1
    const data = 'cmd=' + port + 'A' + ':' + value;

    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + adapter.config.password + '/?' + data
    };
    adapter.log.debug(`Send command "${data}" to ${adapter.config.ip}`);

    // Set up the request
    httpGet(options, (err, data) => {
        if (adapter.config.ports[port]) {
            // Set state only if positive response from megaD
            adapter.setState(adapter.config.ports[port].id + '_A', !!value, true);
        } else {
            adapter.log.warn('Unknown port ' + port);
        }
    });
}

function sendCommandToDSB(port, value) {          //DS2413 port B
    //http://192.168.1.14/sec/?cmd=7A:0 or &cmd=7A:1
    const data = `cmd=${port}B:${value}`;

    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: `/${adapter.config.password}/?${data}`
    };
    adapter.log.debug(`Send command "${data}" to ${adapter.config.ip}`);

    // Set up the request
    httpGet(options, (/* err, data */) => {
        if (adapter.config.ports[port]) {
            // Set state only if positive response from megaD
            adapter.setState(adapter.config.ports[port].id + '_B', !!value, true);
        } else {
            adapter.log.warn('Unknown port ' + port);
        }
    });
}

function sendCommandToEXT(id, port, ext, value) {          //MCP
    //http://192.168.1.14/sec/?cmd=36e3:4000
    if (adapter.config.ports[port].pty == 4 && adapter.config.ports[port].d == 21) {
        if (value > 4095) value = 4095;
        if (value < 0) value = 0;
    }
    const data = 'cmd=' + ext + ':' + value;

    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + adapter.config.password + '/?' + data
    };
    adapter.log.debug('Send command "' + data + '" to ' + adapter.config.ip);

    // Set up the request
    httpGet(options, (err, data) => {
        if (adapter.config.ports[port]) {
            if (adapter.config.ports[port].pty == 4 && adapter.config.ports[port].d == 20) {
                // Set state only if positive response from megaD
                adapter.setState(id, !!value, true);
            } else {
                // Set state only if positive response from megaD
                adapter.setState(id, value, true);
            }
        } else {
            adapter.log.warn(`Unknown port ${port}`);
        }
    });
}

function sendCommandToDisplay(port, value) {
    //'http://192.168.1.15/sec/?pt=30&text=_12;35'
    const data = 'pt=' + port + '&text=' + (value || '');

    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + adapter.config.password + '/?' + data
    };
    adapter.log.debug(`Send command "${data}" to ${adapter.config.ip}`);

    // Set up the request
    httpGet(options);
}

function sendCommandToCounter(port, value) {
    //'http://192.168.0.52/sec/?pt=2&cnt=0'
    const data = 'pt=' + port + '&cnt=' + (value || 0);

    const parts = adapter.config.ip.split(':');

    const options = {
        host: parts[0],
        port: parts[1] || 80,
        path: '/' + adapter.config.password + '/?' + data
    };
    adapter.log.debug(`Send command "${data}" to ${adapter.config.ip}`);

    // Set up the request
    httpGet(options);
}

function addToEnum(enumName, id, callback) {
    adapter.getForeignObject(enumName, (err, obj) => {
        if (!err && obj) {
            const pos = obj.common.members.indexOf(id);
            if (pos === -1) {
                obj.common.members.push(id);
                adapter.setForeignObject(obj._id, obj, err => {
                    callback && callback(err);
                });
            } else {
                callback && callback(err);
            }
        } else {
            callback && callback(err);
        }
    });
}

function removeFromEnum(enumName, id, callback) {
    adapter.getForeignObject(enumName, (err, obj) => {
        if (!err && obj) {
            const pos = obj.common.members.indexOf(id);
            if (pos !== -1) {
                obj.common.members.splice(pos, 1);
                adapter.setForeignObject(obj._id, obj, err => {
                    callback && callback(err);
                });
            } else {
                callback && callback(err);
            }
        } else {
            callback && callback(err);
        }
    });
}

function syncObjects() {

    adapter.config.longPress = parseInt(adapter.config.longPress, 10) || 0;
    adapter.config.doublePress = parseInt(adapter.config.doublePress, 10) || 0;

    const newObjects = [];
    ports = {};
    if (adapter.config.ports) {
        for (let p = 0; p < adapter.config.ports.length; p++) {
            const settings = adapter.config.ports[p];
            let id = p == 37 ? 'p' + p : 'p' + p; // ??

            if (settings.name) {
                id += '_' + settings.name.replace(/[\s.]/g, '_');
            }
            adapter.config.ports[p].id = adapter.namespace + '.' + id;
            adapter.config.ports[p].pty = parseInt(adapter.config.ports[p].pty, 10) || 0;
            if (adapter.config.ports[p].m !== undefined) {
                adapter.config.ports[p].m = parseInt(adapter.config.ports[p].m, 10) || 0;
            }
            if (adapter.config.ports[p].d !== undefined) {
                adapter.config.ports[p].d = parseInt(adapter.config.ports[p].d, 10) || 0;
            }
            if (adapter.config.ports[p].misc === 'false' || adapter.config.ports[p].misc === false) {
                adapter.config.ports[p].misc = 0;
            }
            if (adapter.config.ports[p].misc === 'true' || adapter.config.ports[p].misc === true) {
                adapter.config.ports[p].misc = 1;
            }

            if (adapter.config.ports[p].ext !== undefined) {   //EXT
                adapter.config.ports[p].ext = parseInt(adapter.config.ports[p].ext, 10) || 0;
            }

            settings.port = p;

            let obj = {
                _id: adapter.namespace + '.' + id,
                common: {
                    name: settings.name || ('P' + p),
                    role: settings.role
                },
                native: JSON.parse(JSON.stringify(settings)),
                type: 'state'
            };
            let obj1 = null;
            let obj2 = null;
            let obj3 = null;
            let obj4 = null;
            let obj5 = null;
            let obj6 = null;
            let obj7 = null;
            let obj8 = null;
            let obj9 = null;
            let obj10 = null;
            let obj11 = null;
            let obj12 = null;
            let obj13 = null;
            let obj14 = null;
            let obj15 = null;
            //let obj16 = null;
            //let obj17 = null;
            let obj18 = null;
            let obj19 = null;
            let obj20 = null;
            let obj21 = null;
            let obj22 = null;
            let obj23 = null;
            let obj24 = null;
            let obj25 = null;
            let obj26 = null;
            let obj27 = null;
            let obj28 = null;
            let obj29 = null;
            let obj30 = null;
            let obj31 = null;
            let obj32 = null;
            let obj33 = null;
            let obj34 = null;

            // input
            if (!settings.pty) {
                obj.common.write = false;
                obj.common.read = true;
                obj.common.def = false;
                obj.common.desc = 'P' + p + ' - digital input';
                obj.common.type = 'boolean';
                if (!obj.common.role) {
                    obj.common.role = 'state';
                }

                ///if (settings.m == 1) {
                if (settings.m == 1 || settings.misc == 1) {
                    if (settings.long && adapter.config.longPress) {
                        obj1 = {
                            _id: `${adapter.namespace}.${id}_long`,
                            common: {
                                name: obj.common.name + '_long',
                                role: 'state',
                                write: false,
                                read: true,
                                def: false,
                                desc: `P${p} - long press`,
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj1.native.double !== undefined) delete obj1.native.double;
                    }
                }

                if (settings.double && adapter.config.doublePress) {
                    obj2 = {
                        _id: `${adapter.namespace}.${id}_double`,
                        common: {
                            name: obj.common.name + '_double',
                            role: 'state',
                            write: false,
                            read: true,
                            def: false,
                            desc: `P${p} - double press`,
                            type: 'boolean'
                        },
                        native: JSON.parse(JSON.stringify(settings)),
                        type: 'state'
                    };
                    if (obj2.native.long !== undefined) delete obj2.native.long;
                }
                obj3 = {
                    _id: `${adapter.namespace}.${id}_counter`,
                    common: {
                        name: obj.common.name + '_counter',
                        role: 'state',
                        write: true,
                        read: true,
                        def: 0,
                        desc: `P${p} - inputs counter`,
                        type: 'number'
                    },
                    native: JSON.parse(JSON.stringify(settings)),
                    type: 'state'
                };
            } else
                // output
            if (settings.pty == 1) {
                if (settings.m == 1) {
                    settings.factor = parseFloat(settings.factor || 1);
                    settings.offset = parseFloat(settings.offset || 0);

                    obj.common.write = true;
                    obj.common.read = true;
                    obj.common.def = 0;
                    obj.common.desc = `P${p} - digital output (PWM)`;
                    obj.common.type = 'number';
                    obj.common.min = 0;
                    obj.common.max = 255;
                    if (!obj.common.role) obj.common.role = 'level';
                } else if (settings.m == 0 || settings.m == 3) {
                    obj.common.write = true;
                    obj.common.read = true;
                    obj.common.def = false;
                    obj.common.desc = `P${p} - digital output`;
                    obj.common.type = 'boolean';
                    if (!obj.common.role) obj.common.role = 'state';
                } else if (settings.m == 2) {   //DS2413
                    obj = {
                        _id: adapter.namespace + '.' + id + '_A',
                        common: {
                            name: obj.common.name + '_A',
                            role: 'button',
                            write: true,
                            read: true,
                            def: false,
                            desc: `P${p} - digital output A`,
                            type: 'boolean'
                        },
                        native: JSON.parse(JSON.stringify(settings)),
                        type: 'state'
                    };
                    if (obj.native.misc !== undefined) delete obj.native.misc;
                    if (obj.native.m2 !== undefined) delete obj.native.m2;
                    if (obj.native.fr !== undefined) delete obj.native.fr;
                    if (obj.native.d !== undefined) delete obj.native.d;
                    obj1 = {
                        _id: `${adapter.namespace}.${id}_B`,
                        common: {
                            name: obj.native.name + '_B',
                            role: 'button',
                            write: true,
                            read: true,
                            def: false,
                            desc: `P${p} - digital output B`,
                            type: 'boolean'
                        },
                        native: JSON.parse(JSON.stringify(settings)),
                        type: 'state'
                    };
                    if (obj1.native.misc !== undefined) delete obj1.native.misc;
                    if (obj1.native.m2 !== undefined) delete obj1.native.m2;
                    if (obj1.native.fr !== undefined) delete obj1.native.fr;
                    if (obj1.native.d !== undefined) delete obj1.native.d;
                }
            } else
                // analog ADC
            if (settings.pty == 2) {
                settings.factor = parseFloat(settings.factor || 1);
                settings.offset = parseFloat(settings.offset || 0);

                obj.common.write = false;
                obj.common.read = true;
                obj.common.def = 0;
                obj.common.min = settings.offset;
                obj.common.max = settings.offset + settings.factor;
                obj.common.desc = 'P' + p + ' - analog input';
                obj.common.type = 'number';
                if (!obj.common.role) obj.common.role = 'value';
                obj.native.threshold = settings.offset + settings.factor * settings.misc;
            } else
                // digital temperature sensor
            if (settings.pty == 3 && settings.d != 6) {
                obj.common.write = false;
                obj.common.read = true;
                obj.common.def = 0;
                obj.common.type = 'number';
                if (settings.d == 1 || settings.d == 2 || settings.d == 3) {
                    obj.common.min = -30;
                    obj.common.max = 30;
                    obj.common.unit = '°C';
                    obj.common.desc = `P${p} - temperature`;
                    obj.common.type = 'number';
                    if (!obj.common.role) obj.common.role = 'value.temperature';

                    if (settings.d == 1 || settings.d == 2) {
                        obj1 = {
                            _id: `${adapter.namespace}.${id}_humidity`,
                            common: {
                                name: obj.common.name + '_humidity',
                                role: 'value.humidity',
                                write: false,
                                read: true,
                                unit: '%',
                                def: 0,
                                min: 0,
                                max: 100,
                                desc: `P${p} - humidity`,
                                type: 'number'
                            },
                            native: {
                                port: p
                            },
                            type: 'state'
                        };
                    }
                } else if (settings.d == 4) { // iButton
                    obj.common.desc = 'P' + p + ' - iButton';
                    obj.common.type = 'string';
                    obj.common.def = '';
                } else if (settings.d == 5) { // 1Wire
                    if (settings.dlist != undefined) {
                        const sensor = settings.dlist.split(';');
                        for (const i in sensor)
                            if (i == 0)
                                obj = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.common.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            else if (i == 1)
                                obj1 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.native.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            else if (i == 2)
                                obj2 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.native.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            else if (i == 3)
                                obj3 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.native.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            else if (i == 4)
                                obj4 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.native.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            else if (i == 5)
                                obj5 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.native.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            else if (i == 6)
                                obj6 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.native.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            else if (i == 7)
                                obj7 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.native.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            else if (i == 8)
                                obj8 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.native.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            else if (i == 9)
                                obj9 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i],
                                    common: {
                                        name: obj.native.name + '_' + sensor[i],
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ////native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                    }
                }
            } else if (settings.pty == 3 && settings.d == 6 && settings.m == 1) {  // Wiegand 26
                obj.common.write = false;
                obj.common.read = true;
                obj.common.desc = 'P' + p + ' - wiegand 26';
                obj.common.type = 'string';
                obj.common.def = '';

            } else
                // I2C sensor
            if (settings.pty == 4 && settings.m == 1) {
                let test = '';
                if (settings.scan !== undefined) {
                    const sensor = settings.scan.split(',');
                    if (settings.d == 1) test = 'HTU21D';
                    if (settings.d == 2) test = 'BH1750';
                    if (settings.d == 3) test = 'TSL2591';
                    if (settings.d == 4) test = 'SSD1306';
                    if (settings.d == 5) test = 'BMP180';
                    if (settings.d == 6) test = 'BMx280';
                    if (settings.d == 7) test = 'MAX44009';
                    if (settings.d == 20) test = 'MCP230XX';
                    if (settings.d == 21) test = 'PCA9685';

                    for (const i in sensor)
                        if (sensor) {
                            if (sensor[i] == test) continue;

                            // Light Sensors  // settings.d == 2 || settings.d == 3 || settings.d == 7
                            if (sensor[i].indexOf('BH1750') !== -1) {
                                obj18 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_light',
                                    common: {
                                        name: obj.common.name + '_light',
                                        role: 'value.light',
                                        write: false,
                                        read: true,
                                        unit: 'lux',
                                        def: 0,
                                        desc: 'P' + p + ' - light',
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            } else if (sensor[i].indexOf('TSL2591') !== -1) {
                                obj19 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_light',
                                    common: {
                                        name: obj.common.name + '_light',
                                        role: 'value.light',
                                        write: false,
                                        read: true,
                                        unit: 'lux',
                                        def: 0,
                                        desc: 'P' + p + ' - light',
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            } else if (sensor[i].indexOf('MAX44009') !== -1) {
                                obj20 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_light',
                                    common: {
                                        name: obj.common.name + '_light',
                                        role: 'value.light',
                                        write: false,
                                        read: true,
                                        unit: 'lux',
                                        def: 0,
                                        desc: 'P' + p + ' - light',
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                // Display  // settings.d == 4
                            } else if (sensor[i].indexOf('SSD1306') !== -1) {
                                obj21 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_display',
                                    common: {
                                        name: obj.common.name + '_display',
                                        role: 'state',
                                        write: true,
                                        read: false,
                                        def: '',
                                        desc: 'P' + p + ' - display',
                                        type: 'string'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                //
                            } else if (sensor[i].indexOf('HTU21D') !== -1) {
                                obj22 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_temperature',
                                    common: {
                                        name: obj.common.name + '_temperature',
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                obj23 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_humidity',
                                    common: {
                                        name: obj.native.name + '_humidity',
                                        role: 'value.humidity',
                                        write: false,
                                        read: true,
                                        unit: '%',
                                        def: 0,
                                        min: 0,
                                        max: 100,
                                        desc: 'P' + p + ' - humidity',
                                        type: 'number'
                                    },
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                //
                            } else if (sensor[i].indexOf('ADS1115') !== -1) {
                                obj24 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_0',
                                    common: {
                                        name: obj.common.name + '_0',
                                        role: 'value',
                                        write: false,
                                        read: true,
                                        def: 0,
                                        min: 0,
                                        max: 0,
                                        desc: 'P' + p + ' - analog input 0',
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                obj25 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_1',
                                    common: {
                                        name: obj.common.name + '_1',
                                        role: 'value',
                                        write: false,
                                        read: true,
                                        def: 0,
                                        min: 0,
                                        max: 0,
                                        desc: `P${p} - analog input 1`,
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                obj26 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_2',
                                    common: {
                                        name: obj.common.name + '_2',
                                        role: 'value',
                                        write: false,
                                        read: true,
                                        def: 0,
                                        min: 0,
                                        max: 0,
                                        desc: 'P' + p + ' - analog input 2',
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                obj27 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_3',
                                    common: {
                                        name: obj.common.name + '_3',
                                        role: 'value',
                                        write: false,
                                        read: true,
                                        def: 0,
                                        min: 0,
                                        max: 0,
                                        desc: 'P' + p + ' - analog input 3',
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                //               // settings.d = 5;
                            } else if (sensor[i].indexOf('BMP180') !== -1) {
                                obj28 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_pressure',
                                    common: {
                                        name: obj.native.name + '_pressure',
                                        role: 'value.pressure',
                                        write: false,
                                        read: true,
                                        unit: 'kPa',
                                        def: 0,
                                        min: 0,
                                        max: 1000,
                                        desc: 'P' + p + ' - pressure',
                                        type: 'number'
                                    },
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                obj29 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_temperature',
                                    common: {
                                        name: obj.native.name + '_temperature',
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            } else if (sensor[i].indexOf('BMX280') !== -1) {
                                obj30 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_pressure',
                                    common: {
                                        name: obj.native.name + '_pressure',
                                        role: 'value.pressure',
                                        write: false,
                                        read: true,
                                        unit: 'kPa',
                                        def: 0,
                                        min: 0,
                                        max: 1000,
                                        desc: 'P' + p + ' - pressure',
                                        type: 'number'
                                    },
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                obj31 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_temperature',
                                    common: {
                                        name: obj.native.name + '_temperature',
                                        role: 'value.temperature',
                                        write: false,
                                        read: true,
                                        unit: '°C',
                                        def: 0,
                                        min: -30,
                                        max: 30,
                                        desc: 'P' + p + ' - temperature',
                                        type: 'number'
                                    },
                                    ///native: JSON.parse(JSON.stringify(settings)),
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                                obj32 = {
                                    _id: adapter.namespace + '.' + id + '_' + sensor[i] + '_humidity',
                                    common: {
                                        name: obj.native.name + '_humidity',
                                        role: 'value.humidity',
                                        write: false,
                                        read: true,
                                        unit: '%',
                                        def: 0,
                                        min: 0,
                                        max: 100,
                                        desc: 'P' + p + ' - humidity',
                                        type: 'number'
                                    },
                                    native: {
                                        port: p,
                                        name: 'P' + p
                                    },
                                    type: 'state'
                                };
                            }
                        }
                }
                ///if (settings.pty == 4 && settings.m == 1 && settings.d != 0) {
                ///if (settings.pty == 4 && settings.m == 1) {
                ///obj.common.write = false;
                ///obj.common.read  = true;
                ///obj.common.def   = 0;
                ///obj.common.type  = 'number';
                if (settings.d == 1) {
                    obj.common.write = false;
                    obj.common.read = true;
                    obj.common.min = -30;
                    obj.common.max = 30;
                    obj.common.unit = '°C';
                    obj.common.def = 0;
                    obj.common.desc = 'P' + p + ' - temperature';
                    obj.common.type = 'number';
                    if (!obj.common.role) obj.common.role = 'value.temperature';
                    obj1 = {
                        _id: adapter.namespace + '.' + id + '_humidity',
                        common: {
                            name: obj.common.name + '_humidity',
                            role: 'value.humidity',
                            write: false,
                            read: true,
                            unit: '%',
                            def: 0,
                            min: 0,
                            max: 100,
                            desc: 'P' + p + ' - humidity',
                            type: 'number'
                        },
                        native: {
                            port: p
                        },
                        type: 'state'
                    };
                    // Light Sensors BH1750	|| TSL2591 || MAX44009
                } else if (settings.d == 2 || settings.d == 3 || settings.d == 7) {
                    obj.common.write = false;
                    obj.common.read = true;
                    obj.common.desc = 'P' + p + ' - light';
                    obj.common.type = 'number';
                    obj.common.def = 0;
                    obj.common.unit = 'lux';
                    obj.common.role = 'value.light';
                    // Display SSD1306
                } else if (settings.d == 4) {
                    obj.common.write = true;
                    obj.common.read = false;
                    obj.common.desc = 'P' + p + ' - display';
                    obj.common.type = 'string';
                    obj.common.def = '';
                    if (!obj.common.role) obj.common.role = 'state';
                    // BMP180
                } else if (settings.d == 5) {
                    obj.common.write = false;
                    obj.common.read = true;
                    obj.common.def = 0;
                    obj.common.min = -30;
                    obj.common.max = 30;
                    obj.common.unit = '°C';
                    obj.common.desc = 'P' + p + ' - temperature';
                    obj.common.type = 'number';
                    if (!obj.common.role) obj.common.role = 'value.temperature';
                    obj1 = {
                        _id: adapter.namespace + '.' + id + '_pressure',
                        common: {
                            name: obj.common.name + '_pressure',
                            role: 'value.pressure',
                            write: false,
                            read: true,
                            unit: 'kPa',
                            def: 0,
                            min: 0,
                            max: 1000,
                            desc: 'P' + p + ' - pressure',
                            type: 'number'
                        },
                        native: {
                            port: p
                        },
                        type: 'state'
                    };
                    //BMx280
                } else if (settings.d == 6) {
                    obj.common.write = false;
                    obj.common.read = true;
                    obj.common.def = 0;
                    obj.common.min = -30;
                    obj.common.max = 30;
                    obj.common.unit = '°C';
                    obj.common.desc = 'P' + p + ' - temperature';
                    obj.common.type = 'number';
                    if (!obj.common.role) obj.common.role = 'value.temperature';
                    obj1 = {
                        _id: adapter.namespace + '.' + id + '_pressure',
                        common: {
                            name: obj.common.name + '_pressure',
                            role: 'value.pressure',
                            write: false,
                            read: true,
                            unit: 'kPa',
                            def: 0,
                            min: 0,
                            max: 1000,
                            desc: 'P' + p + ' - pressure',
                            type: 'number'
                        },
                        native: {
                            port: p
                        },
                        type: 'state'
                    };
                    obj2 = {
                        _id: adapter.namespace + '.' + id + '_humidity',
                        common: {
                            name: obj.common.name + '_humidity',
                            role: 'value.humidity',
                            write: false,
                            read: true,
                            unit: '%',
                            def: 0,
                            min: 0,
                            max: 100,
                            desc: 'P' + p + ' - humidity',
                            type: 'number'
                        },
                        native: {
                            port: p
                        },
                        type: 'state'
                    };
                    // MCP230XX
                } else if (settings.d == 20) {
                    // MCP23008
                    if (settings.ext == 8) {
                        obj = {
                            _id: adapter.namespace + '.' + id + '_P0',
                            common: {
                                name: obj.native.name + '_P0',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P0',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            ///native: {
                            ///name: p,
                            ///port: p + '_P0',
                            ///ext: p + 'e0',
                            ///},
                            type: 'state'
                        };
                        if (obj.native.ext !== undefined) obj.native.ext = p + 'e0';
                        obj1 = {
                            _id: adapter.namespace + '.' + id + '_P1',
                            common: {
                                name: obj.native.name + '_P1',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P1',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj1.native.ext !== undefined) obj1.native.ext = p + 'e1';
                        obj2 = {
                            _id: adapter.namespace + '.' + id + '_P2',
                            common: {
                                name: obj.native.name + '_P2',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P2',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj2.native.ext !== undefined) obj2.native.ext = p + 'e2';
                        obj3 = {
                            _id: adapter.namespace + '.' + id + '_P3',
                            common: {
                                name: obj.native.name + '_P3',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P3',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj3.native.ext !== undefined) obj3.native.ext = p + 'e3';
                        obj4 = {
                            _id: adapter.namespace + '.' + id + '_P4',
                            common: {
                                name: obj.native.name + '_P4',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P4',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj4.native.ext !== undefined) obj4.native.ext = p + 'e4';
                        obj5 = {
                            _id: adapter.namespace + '.' + id + '_P5',
                            common: {
                                name: obj.native.name + '_P5',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P5',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj5.native.ext !== undefined) obj5.native.ext = p + 'e5';
                        obj6 = {
                            _id: adapter.namespace + '.' + id + '_P6',
                            common: {
                                name: obj.native.name + '_P6',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P6',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj6.native.ext !== undefined) obj6.native.ext = p + 'e6';
                        obj7 = {
                            _id: adapter.namespace + '.' + id + '_P7',
                            common: {
                                name: obj.native.name + '_P7',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P7',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj7.native.ext !== undefined) obj7.native.ext = p + 'e7';
                    } else {
                        obj = {
                            _id: adapter.namespace + '.' + id + '_P0',
                            common: {
                                name: obj.native.name + '_P0',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P0',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            ///native: {
                            ///name: p,
                            ///port: p + '_P0',
                            ///ext : p + 'e0',
                            ///},
                            type: 'state'
                        };
                        if (obj.native.ext !== undefined) obj.native.ext = p + 'e0';
                        obj1 = {
                            _id: adapter.namespace + '.' + id + '_P1',
                            common: {
                                name: obj.native.name + '_P1',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P1',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj1.native.ext !== undefined) obj1.native.ext = p + 'e1';
                        obj2 = {
                            _id: adapter.namespace + '.' + id + '_P2',
                            common: {
                                name: obj.native.name + '_P2',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P2',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj2.native.ext !== undefined) obj2.native.ext = p + 'e2';
                        obj3 = {
                            _id: adapter.namespace + '.' + id + '_P3',
                            common: {
                                name: obj.native.name + '_P3',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P3',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj3.native.ext !== undefined) obj3.native.ext = p + 'e3';
                        obj4 = {
                            _id: adapter.namespace + '.' + id + '_P4',
                            common: {
                                name: obj.native.name + '_P4',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P4',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj4.native.ext !== undefined) obj4.native.ext = p + 'e4';
                        obj5 = {
                            _id: adapter.namespace + '.' + id + '_P5',
                            common: {
                                name: obj.native.name + '_P5',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P5',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj5.native.ext !== undefined) obj5.native.ext = p + 'e5';
                        obj6 = {
                            _id: adapter.namespace + '.' + id + '_P6',
                            common: {
                                name: obj.native.name + '_P6',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P6',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj6.native.ext !== undefined) obj6.native.ext = p + 'e6';
                        obj7 = {
                            _id: adapter.namespace + '.' + id + '_P7',
                            common: {
                                name: obj.native.name + '_P7',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P7',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj7.native.ext !== undefined) obj7.native.ext = p + 'e7';
                        obj8 = {
                            _id: adapter.namespace + '.' + id + '_P8',
                            common: {
                                name: obj.native.name + '_P8',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P8',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj8.native.ext !== undefined) obj8.native.ext = p + 'e8';
                        obj9 = {
                            _id: adapter.namespace + '.' + id + '_P9',
                            common: {
                                name: obj.native.name + '_P9',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P9',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj9.native.ext !== undefined) obj9.native.ext = p + 'e9';
                        obj10 = {
                            _id: adapter.namespace + '.' + id + '_P10',
                            common: {
                                name: obj.native.name + '_P10',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P10',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj10.native.ext !== undefined) obj10.native.ext = p + 'e10';
                        obj11 = {
                            _id: adapter.namespace + '.' + id + '_P11',
                            common: {
                                name: obj.native.name + '_P11',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P11',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj11.native.ext !== undefined) obj11.native.ext = p + 'e11';
                        obj12 = {
                            _id: adapter.namespace + '.' + id + '_P12',
                            common: {
                                name: obj.native.name + '_P12',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P12',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj12.native.ext !== undefined) obj12.native.ext = p + 'e12';
                        obj13 = {
                            _id: adapter.namespace + '.' + id + '_P13',
                            common: {
                                name: obj.native.name + '_P13',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P13',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj13.native.ext !== undefined) obj13.native.ext = p + 'e13';
                        obj14 = {
                            _id: adapter.namespace + '.' + id + '_P14',
                            common: {
                                name: obj.native.name + '_P14',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P14',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj14.native.ext !== undefined) obj14.native.ext = p + 'e14';
                        obj15 = {
                            _id: adapter.namespace + '.' + id + '_P15',
                            common: {
                                name: obj.native.name + '_P15',
                                role: 'state',
                                write: true,
                                read: true,
                                def: false,
                                desc: 'P' + p + ' - digital input/output P15',
                                type: 'boolean'
                            },
                            native: JSON.parse(JSON.stringify(settings)),
                            type: 'state'
                        };
                        if (obj15.native.ext !== undefined) obj15.native.ext = p + 'e15';
                    }
                } else if (settings.d == 21) {   // PCA9685
                    obj = {
                        _id: adapter.namespace + '.' + id + '_P0',
                        common: {
                            name: obj.native.name + '_P0',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P0' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e0',
                        },
                        type: 'state'
                    };
                    obj.native.ext = p + 'e0';
                    obj1 = {
                        _id: adapter.namespace + '.' + id + '_P1',
                        common: {
                            name: obj.native.name + '_P1',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P1' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e1',
                        },
                        type: 'state'
                    };
                    obj2 = {
                        _id: adapter.namespace + '.' + id + '_P2',
                        common: {
                            name: obj.native.name + '_P2',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P2' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e2',
                        },
                        type: 'state'
                    };
                    obj3 = {
                        _id: adapter.namespace + '.' + id + '_P3',
                        common: {
                            name: obj.native.name + '_P3',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P3' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e3',
                        },
                        type: 'state'
                    };
                    obj4 = {
                        _id: adapter.namespace + '.' + id + '_P4',
                        common: {
                            name: obj.native.name + '_P4',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P4' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e4',
                        },
                        type: 'state'
                    };
                    obj5 = {
                        _id: adapter.namespace + '.' + id + '_P5',
                        common: {
                            name: obj.native.name + '_P5',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P5' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e5',
                        },
                        type: 'state'
                    };
                    obj6 = {
                        _id: adapter.namespace + '.' + id + '_P6',
                        common: {
                            name: obj.native.name + '_P6',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P6' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e6',
                        },
                        type: 'state'
                    };
                    obj7 = {
                        _id: adapter.namespace + '.' + id + '_P7',
                        common: {
                            name: obj.native.name + '_P7',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P7' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e7',
                        },
                        type: 'state'
                    };
                    obj8 = {
                        _id: adapter.namespace + '.' + id + '_P8',
                        common: {
                            name: obj.native.name + '_P8',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P8' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e8',
                        },
                        type: 'state'
                    };
                    obj9 = {
                        _id: adapter.namespace + '.' + id + '_P9',
                        common: {
                            name: obj.native.name + '_P9',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P9' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e9',
                        },
                        type: 'state'
                    };
                    obj10 = {
                        _id: adapter.namespace + '.' + id + '_P10',
                        common: {
                            name: obj.native.name + '_P10',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P10' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e10',
                        },
                        type: 'state'
                    };
                    obj11 = {
                        _id: adapter.namespace + '.' + id + '_P11',
                        common: {
                            name: obj.native.name + '_P11',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P11' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e11',
                        },
                        type: 'state'
                    };
                    obj12 = {
                        _id: adapter.namespace + '.' + id + '_P12',
                        common: {
                            name: obj.native.name + '_P12',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P12' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e12',
                        },
                        type: 'state'
                    };
                    obj13 = {
                        _id: adapter.namespace + '.' + id + '_P13',
                        common: {
                            name: obj.native.name + '_P13',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P13' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e13',
                        },
                        type: 'state'
                    };
                    obj14 = {
                        _id: adapter.namespace + '.' + id + '_P14',
                        common: {
                            name: obj.native.name + '_P14',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P14' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e14',
                        },
                        type: 'state'
                    };
                    obj15 = {
                        _id: adapter.namespace + '.' + id + '_P15',
                        common: {
                            name: obj.native.name + '_P15',
                            role: 'level',
                            write: true,
                            read: true,
                            def: 0,
                            desc: 'P' + p + '_P15' + ' - digital output (PWM)',
                            type: 'number'
                        },
                        ///native: JSON.parse(JSON.stringify(settings)),
                        native: {
                            port: p,
                            name: 'P' + p,
                            ext: p + 'e15',
                        },
                        type: 'state'
                    };
                }
            } else {
                continue;
            }

            if (settings.pty == 4 && settings.m == 1 && settings.d == 0) {
                ///adapter.log.debug('TEST');
            } else {
                newObjects.push(obj);
                ports[obj._id] = obj;
            }

            if (obj1) {
                newObjects.push(obj1);
                ports[obj1._id] = obj1;
            }
            if (obj2) {
                newObjects.push(obj2);
                ports[obj2._id] = obj2;
            }
            if (obj3) {
                newObjects.push(obj3);
                ports[obj3._id] = obj3;
            }
            if (obj4) {
                newObjects.push(obj4);
                ports[obj4._id] = obj4;
            }
            if (obj5) {
                newObjects.push(obj5);
                ports[obj5._id] = obj5;
            }
            if (obj6) {
                newObjects.push(obj6);
                ports[obj6._id] = obj6;
            }
            if (obj7) {
                newObjects.push(obj7);
                ports[obj7._id] = obj7;
            }
            if (obj8) {
                newObjects.push(obj8);
                ports[obj8._id] = obj8;
            }
            if (obj9) {
                newObjects.push(obj9);
                ports[obj9._id] = obj9;
            }
            if (obj10) {
                newObjects.push(obj10);
                ports[obj10._id] = obj10;
            }
            if (obj11) {
                newObjects.push(obj11);
                ports[obj11._id] = obj11;
            }
            if (obj12) {
                newObjects.push(obj12);
                ports[obj12._id] = obj12;
            }
            if (obj13) {
                newObjects.push(obj13);
                ports[obj13._id] = obj13;
            }
            if (obj14) {
                newObjects.push(obj14);
                ports[obj14._id] = obj14;
            }
            if (obj15) {
                newObjects.push(obj15);
                ports[obj15._id] = obj15;
            }
            if (obj18) {
                newObjects.push(obj18);
                ports[obj18._id] = obj18;
            }
            if (obj19) {
                newObjects.push(obj19);
                ports[obj19._id] = obj19;
            }
            if (obj20) {
                newObjects.push(obj20);
                ports[obj20._id] = obj20;
            }
            if (obj21) {
                newObjects.push(obj21);
                ports[obj21._id] = obj21;
            }
            if (obj22) {
                newObjects.push(obj22);
                ports[obj22._id] = obj22;
            }
            if (obj23) {
                newObjects.push(obj23);
                ports[obj23._id] = obj23;
            }
            if (obj24) {
                newObjects.push(obj24);
                ports[obj24._id] = obj24;
            }
            if (obj25) {
                newObjects.push(obj25);
                ports[obj25._id] = obj25;
            }
            if (obj26) {
                newObjects.push(obj26);
                ports[obj26._id] = obj26;
            }
            if (obj27) {
                newObjects.push(obj27);
                ports[obj27._id] = obj27;
            }
            if (obj28) {
                newObjects.push(obj28);
                ports[obj28._id] = obj28;
            }
            if (obj29) {
                newObjects.push(obj29);
                ports[obj29._id] = obj29;
            }
            if (obj30) {
                newObjects.push(obj30);
                ports[obj30._id] = obj30;
            }
            if (obj31) {
                newObjects.push(obj31);
                ports[obj31._id] = obj31;
            }
            if (obj32) {
                newObjects.push(obj32);
                ports[obj32._id] = obj32;
            }
            if (obj33) {
                newObjects.push(obj33);
                ports[obj33._id] = obj33;
            }
            if (obj34) {
                newObjects.push(obj34);
                ports[obj33._id] = obj34;
            }
        }
    }

    // read actual objects
    adapter.getStatesOf('', '', (err, _states) => {
        let i;
        let j;
        let found;
        // synchronize actual and new

        // Sync existing
        for (i = 0; i < newObjects.length; i++) {
            for (j = 0; j < _states.length; j++) {
                if (newObjects[i]._id === _states[j]._id) {
                    const mergedObj = JSON.parse(JSON.stringify(_states[j]));

                    if (mergedObj.common.history) delete mergedObj.common.history;
                    if (mergedObj.common.mobile) delete mergedObj.common.mobile;

                    if (JSON.stringify(mergedObj) !== JSON.stringify(newObjects[i])) {
                        adapter.log.info('Update state ' + newObjects[i]._id);
                        if (_states[j].common.history) newObjects[i].common.history = _states[j].common.history;
                        if (_states[j].common.mobile) newObjects[i].common.mobile = _states[j].common.mobile;
                        adapter.setObject(newObjects[i]._id, newObjects[i]);
                    }

                    if (newObjects[i].native.room !== _states[j].native.room) {
                        adapter.log.info('Update state room ' + newObjects[i]._id + ': ' + _states[j].native.room + ' => ' + newObjects[i].native.room);
                        if (_states[j].native.room) removeFromEnum(_states[j].native.room, _states[j]._id);
                        if (newObjects[i].native.room) addToEnum(newObjects[i].native.room, newObjects[i]._id);
                    }

                    break;
                }
            }
        }

        // Add new
        for (i = 0; i < newObjects.length; i++) {
            found = false;
            for (j = 0; j < _states.length; j++) {
                if (newObjects[i]._id === _states[j]._id) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                adapter.log.info('Add state ' + newObjects[i]._id);

                adapter.setObject(newObjects[i]._id, newObjects[i]);
                // check room
                if (newObjects[i].native.room) addToEnum(newObjects[i].native.room, newObjects[i]._id);
            }
        }

        // Delete old
        for (j = 0; j < _states.length; j++) {
            found = false;
            for (i = 0; i < newObjects.length; i++) {
                if (newObjects[i]._id === _states[j]._id) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                adapter.log.info('Delete state ' + _states[j]._id);
                adapter.delObject(_states[j]._id);
                if (_states[j].native.room) removeFromEnum(_states[j].native.room, _states[j]._id);
            }
        }

        // if 1Wire
        for (let po = 0; po < adapter.config.ports.length; po++) {
            if (adapter.config.ports[po].pty == 3 && adapter.config.ports[po].d == 5) {
                ask1WireTemp = true;
                break;
            }
        }

        // if EXT
        for (let po = 0; po < adapter.config.ports.length; po++) {
            if (adapter.config.ports[po].pty == 4 && (adapter.config.ports[po].d == 20 || adapter.config.ports[po].d == 21)) {
                askEXTport = true;
                break;
            }
        }

        // if I2C
        for (let po = 0; po < adapter.config.ports.length; po++) {
            if (adapter.config.ports[po].pty == 4 && adapter.config.ports[po].m == 1) {
                askI2Cport = true;
                break;
            }
        }

        if (adapter.config.ip && adapter.config.ip !== '0.0.0.0') {
            pollStatus();
            setInterval(pollStatus, adapter.config.pollInterval * 1000);
        }
    });
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//    "cache":  false
//}
function main() {
    adapter.setState('info.connection', false, true);

    if (adapter.config.ip) {
        adapter.config.port = parseInt(adapter.config.port, 10) || 0;
        if (adapter.config.port) {
            server = require('http').createServer(restApi);

            adapter.getPort(adapter.config.port, port => {
                if (port != adapter.config.port && !adapter.config.findNextPort) {
                    adapter.log.warn('port ' + adapter.config.port + ' already in use');
                } else {
                    server.listen(port);
                    adapter.log.info('http server listening on port ' + port);
                }
            });
        } else {
            adapter.log.info('No port specified');
        }
    }
    syncObjects();
    adapter.subscribeStates('*');
}

// If started as allInOne mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
