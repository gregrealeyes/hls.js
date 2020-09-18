/**
 * @author Stephan Hesse <disparat@gmail.com> | <tchakabam@gmail.com>
 * @author Matthew Thompson <matthew@realeyes.com>
 *
 * DRM support for Hls.js
 */

import EventHandler from '../event-handler';
import Event from '../events';
import { ErrorTypes, ErrorDetails } from '../errors';
import { EMEInitDataInfo } from '../config';

import { logger } from '../utils/logger';

interface EMEKeySessionResponse {
  keySession: MediaKeySession,
  levelOrAudioTrack: any
}

/**
 * Controller to deal with encrypted media extensions (EME)
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Encrypted_Media_Extensions_API
 *
 * @class
 * @constructor
 */
class EMEController extends EventHandler {
  private _media: HTMLMediaElement | null = null;
  private _manifestData: any = null;
  private _initDataType: string | null = null;
  private _initData: ArrayBuffer | null = null;
  private _keySessions: MediaKeySession[] = [];
  private _emeConfiguring: boolean = false;
  private _emeConfigured: boolean = false;

  /**
   * User configurations
   */
  private _emeEnabled: boolean;
  private _emeInitDataInFrag: boolean;
  private _reuseEMELicense: boolean;
  private _requestMediaKeySystemAccess: (supportedConfigurations: MediaKeySystemConfiguration[]) => Promise<MediaKeySystemAccess>
  private _getEMEInitializationData: (levelOrAudioTrack: any, initDataType: string | null, initData: ArrayBuffer | null) => Promise<EMEInitDataInfo>;
  private _getEMELicense: (levelOrAudioTrack: any, event: MediaKeyMessageEvent) => Promise<ArrayBuffer>;

  /**
   * @constructs
   * @param {Hls} hls Our Hls.js instance
   */
  constructor (hls) {
    super(hls,
      Event.MEDIA_ATTACHING,
      Event.MANIFEST_PARSED,
      Event.MEDIA_DETACHING
    );

    this._emeEnabled = hls.config.emeEnabled;
    this._emeInitDataInFrag = hls.config.emeInitDataInFrag;
    this._reuseEMELicense = hls.config.reuseEMELicense;
    this._requestMediaKeySystemAccess = hls.config.requestMediaKeySystemAccessFunc;
    this._getEMEInitializationData = hls.config.getEMEInitializationDataFunc;
    this._getEMELicense = hls.config.getEMELicenseFunc;
  }

  /**
   * Creates requests for licenses
   * @private
   * @param {MediaKeySession} session Media Keys Session created on the Media Keys object https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySession
   * @param {Level | AudioTrack} levelOrAudioTrack Either a level or audio track mapped from manifestParsed data, used by client should different licenses be
   * requred for different levels or audio tracks
   * @returns {Promise<any>} Promise resolved or rejected by updating MediaKeySession with license
   */
  private _onMediaKeySessionCreated (session: MediaKeySession, levelOrAudioTrack: any): Promise<any> {
    logger.log('Generating license request');

    return this.getEMEInitializationData(levelOrAudioTrack, this.initDataType, this.initData).then((initDataInfo) => {
      const messagePromise = new Promise((resolve, reject) => {
        session.addEventListener('message', (event: MediaKeyMessageEvent) => {
          logger.log('Received key session message, requesting license');

          this.getEMELicense(levelOrAudioTrack, event).catch(() => {
            reject(ErrorDetails.KEY_SYSTEM_LICENSE_REQUEST_FAILED);
          }).then((license: ArrayBuffer) => {
            logger.log('Received license data, updating key session');

            return (event.target! as MediaKeySession).update(license).then(() => {
              logger.log('Key session updated with license');

              resolve();
            }).catch(() => {
              reject(ErrorDetails.KEY_SYSTEM_LICENSE_UPDATE_FAILED);
            });
          });
        });
      });

      return session.generateRequest(initDataInfo.initDataType, initDataInfo.initData).catch((err) => {
        logger.error('Failed to generate license request:', err);

        return Promise.reject(ErrorDetails.KEY_SYSTEM_GENERATE_REQUEST_FAILED);
      }).then(() => {
        return messagePromise;
      });
    });
  }

  /**
   * Creates a session on the media keys object
   * @private
   * @param {MediaKeys} mediaKeys Media Keys created on the Media Key System access object https://developer.mozilla.org/en-US/docs/Web/API/MediaKeys
   * @param {Level | AudioTrack} levelOrAudioTrack Either a level or audio track mapped from manifestParsed data, used by client should different licenses be
   * requred for different levels or audio tracks
   * @returns {Promise<EMEKeySessionResponse>} Promise that resolves to the Media Key Session created on the Media Keys https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySession
   * Also includes the level or audio track to associate with the session
   */
  private _onMediaKeysSet (mediaKeys: MediaKeys, levelOrAudioTrack: any): Promise<EMEKeySessionResponse> {
    logger.log('Creating session on media keys');

    const keySession = mediaKeys.createSession();

    this.keySessions.push(keySession);

    const keySessionResponse: EMEKeySessionResponse = {
      keySession,
      levelOrAudioTrack
    };

    return Promise.resolve(keySessionResponse);
  }

  /**
   * Sets the media keys on the media
   * @private
   * @param {MediaKeys} mediaKeys Media Keys created on the Key System Access object https://developer.mozilla.org/en-US/docs/Web/API/MediaKeys
   * @returns {Promise<MediaKeys>} Promise that resvoles to the created media keys  https://developer.mozilla.org/en-US/docs/Web/API/MediaKeys
   */
  private _onMediaKeysCreated (mediaKeys): Promise<MediaKeys> {
    if (this.media.mediaKeys) {
      logger.log('Media keys have already been set on media');

      return Promise.resolve(this.media.mediaKeys);
    } else {
      logger.log('Setting media keys on media');

      return this.media.setMediaKeys(mediaKeys).then(() => {
        return Promise.resolve(mediaKeys);
      }).catch((err) => {
        logger.error('Failed to set media keys on media:', err);

        return Promise.reject(ErrorDetails.KEY_SYSTEM_NO_KEYS);
      });
    }
  }

  /**
   * Creates media keys on the media key system access object
   * @private
   * @param {MediaKeySystemAccess} mediaKeySystemAccess https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemAccess
   * @returns {Promise<MediaKeys>} Promise that resolves to the created media keys https://developer.mozilla.org/en-US/docs/Web/API/MediaKeys
   */
  private _onMediaKeySystemAccessObtained (mediaKeySystemAccess: MediaKeySystemAccess): Promise<MediaKeys> {
    if (this.media.mediaKeys) {
      logger.log('Media keys have already been created');

      return Promise.resolve(this.media.mediaKeys);
    } else {
      logger.log('Creating media keys');

      return mediaKeySystemAccess.createMediaKeys().catch((err) => {
        logger.error('Failed to create media-keys:', err);

        return Promise.reject(ErrorDetails.KEY_SYSTEM_NO_KEYS);
      });
    }
  }

  /**
   * Requests Media Key System access object where user defines key system
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Navigator/requestMediaKeySystemAccess
   * @private
   * @param {MediaKeySystemConfiguration[]} mediaKeySystemConfigs Configurations to request Media Key System access with https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemConfiguration
   * @returns {Promise<MediaKeySystemAccess} Promise that resolves to the Media Key System Access object https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemAccess
   */
  private _getMediaKeySystemAccess (mediaKeySystemConfigs: MediaKeySystemConfiguration[]): Promise<MediaKeySystemAccess> {
    logger.log('Requesting encrypted media key system access');

    if (!window.navigator.requestMediaKeySystemAccess) {
      return Promise.reject(ErrorDetails.KEY_SYSTEM_NO_ACCESS);
    }

    return this.requestMediaKeySystemAccess(mediaKeySystemConfigs).catch((err) => {
      logger.error('Failed to obtain media key system access:', err);

      return Promise.reject(ErrorDetails.KEY_SYSTEM_NO_ACCESS);
    });
  }

  /**
   * Creates Media Key System Configurations that will be used to request Media Key System Access
   * @private
   * @param {any} levels Levels found in manifest
   * @returns {Array<MediaSystemConfiguration>} A non-empty Array of MediaKeySystemConfiguration objects https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemConfiguration
   */
  private _getSupportedMediaKeySystemConfigurations (levels: any): MediaKeySystemConfiguration[] {
    const baseConfig: MediaKeySystemConfiguration = {
      audioCapabilities: [], // e.g. { contentType: 'audio/mp4; codecs="avc1.42E01E"' }
      videoCapabilities: [] // e.g. { contentType: 'video/mp4; codecs="avc1.42E01E"' }
    };

    levels.forEach((level) => {
      baseConfig.videoCapabilities!.push({
        contentType: `video/mp4; codecs="${level.videoCodec}"`
      });

      baseConfig.audioCapabilities!.push({
        contentType: `audio/mp4; codecs="${level.audioCodec}"`
      });
    });

    return [
      baseConfig
    ];
  }

  private _configureEME () {
    this.hls.trigger(Event.EME_CONFIGURING, {});

    this._emeConfiguring = true;

    const mediaKeySystemConfigs = this._getSupportedMediaKeySystemConfigurations(this.manifestData.levels);

    this._getMediaKeySystemAccess(mediaKeySystemConfigs).then((mediaKeySystemAccess) => {
      logger.log('Obtained encrypted media key system access');

      return this._onMediaKeySystemAccessObtained(mediaKeySystemAccess);
    }).then((mediaKeys) => {
      logger.log('Created media keys');

      return this._onMediaKeysCreated(mediaKeys);
    }).then((mediaKeys) => {
      logger.log('Set media keys on media');

      let keySessionRequests: Promise<EMEKeySessionResponse>[];

      if (this._reuseEMELicense && this.manifestData.levels.length) {
        keySessionRequests = [this._onMediaKeysSet(mediaKeys, this.manifestData.levels[0])];
      } else {
        const levelRequests = this.manifestData.levels.map((level) => {
          return this._onMediaKeysSet(mediaKeys, level);
        });
  
        const audioRequests = this.manifestData.audioTracks.map((audioTrack) => {
          return this._onMediaKeysSet(mediaKeys, audioTrack);
        });
  
        keySessionRequests = levelRequests.concat(audioRequests);
      }

      return keySessionRequests.reduce((prevKeySessionRequest, currentKeySessionRequest) => {
        return prevKeySessionRequest.then((prevKeySessionResponses) => {
          return currentKeySessionRequest.then((keySessionResponse) => {
            return [...prevKeySessionResponses, keySessionResponse];
          });
        });
      }, Promise.resolve([]));
    }).then((keySessionResponses) => {
      logger.log('Created media key sessions');

      const licenseRequests = keySessionResponses.map((keySessionResponse: EMEKeySessionResponse) => {
        return this._onMediaKeySessionCreated(keySessionResponse.keySession, keySessionResponse.levelOrAudioTrack);
      });

      return licenseRequests.reduce((prevLicenseRequest, currentLicenseRequest) => {
        return prevLicenseRequest.then(() => {
          return currentLicenseRequest;
        });
      }, Promise.resolve());
    }).then(() => {
      logger.log('EME sucessfully configured');

      this._emeConfiguring = false;
      this._emeConfigured = true;

      this.hls.trigger(Event.EME_CONFIGURED, {});
    }).catch((err: string) => {
      logger.error('EME Configuration failed');

      this._emeConfiguring = false;
      this._emeConfigured = false;

      this.hls.trigger(Event.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: err,
        fatal: true
      });
    });
  }

  onMediaAttaching (data: { media: HTMLMediaElement }) {
    let media = data.media;

    if (media) {
      this._media = media; // keep reference of media

      this.media.addEventListener('encrypted', (event) => {
        if (!this._emeConfiguring && !this._emeConfigured) {
          this.initDataType = event.initDataType;

          this.initData = event.initData;
          if (this.manifestData) {
            this._configureEME();
          }
        }
        
      });
    }
  }

  onManifestParsed (data: any) {
    if (this.emeEnabled) {
      this.manifestData = data;

      if (!this.emeInitDataInFrag && !this._emeConfiguring && !this._emeConfigured) {
        this._configureEME();
      }
    }
  }

  onMediaDetaching () {
    if (this.emeEnabled) {
      const keySessionClosePromises: Promise<void>[] = this._keySessions.map((keySession) => {
        return keySession.close();
      });

      Promise.all(keySessionClosePromises).then(() => {
        this._media = null; // release media reference
      });
    }
  }

  // Getters for EME Controller

  get media () {
    if (!this._media) {
      throw new Error('Media has not been set on EME Controller');
    }

    return this._media;
  }

  get manifestData () {
    return this._manifestData;
  }

  set manifestData (value) {
    this._manifestData = value;
  }

  get initDataType () {
    return this._initDataType;
  }

  set initDataType (value) {
    this._initDataType = value;
  }

  get initData () {
    return this._initData;
  }

  set initData (value) {
    this._initData = value;
  }

  get keySessions () {
    return this._keySessions;
  }

  set keySessions (value) {
    this._keySessions = value;
  }

  // Getters for user configurations

  get emeEnabled () {
    return this._emeEnabled;
  }

  get emeInitDataInFrag () {
    return this._emeInitDataInFrag;
  }

  get requestMediaKeySystemAccess () {
    if (!this._requestMediaKeySystemAccess) {
      throw new Error('No requestMediaKeySystemAccess function configured');
    }

    return this._requestMediaKeySystemAccess;
  }

  get getEMEInitializationData () {
    if (!this._getEMEInitializationData) {
      throw new Error('No getInitializationData function configured');
    }

    return this._getEMEInitializationData;
  }

  get getEMELicense () {
    if (!this._getEMELicense) {
      throw new Error('No getEMELicense function configured');
    }

    return this._getEMELicense;
  }
}

export default EMEController;
