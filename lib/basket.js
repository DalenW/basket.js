/*global document, XMLHttpRequest, localStorage, basket, RSVP*/
(function( window, document ) {
	'use strict';

	const head = document.head || document.getElementsByTagName('head')[0];
	const storagePrefix = 'basket-';
	let defaultExpiration = 5000;
	let inBasket = [];

	const addLocalStorage = function( key, storeObj ) {
		try {
			localStorage.setItem( storagePrefix + key, JSON.stringify( storeObj ) );
			return true;
		} catch( e ) {
			if ( e.name.toUpperCase().indexOf('QUOTA') >= 0 ) {
				let item;
				let tempScripts = [];

				for ( item in localStorage ) {
					if ( item.indexOf( storagePrefix ) === 0 ) {
						tempScripts.push( JSON.parse( localStorage[ item ] ) );
					}
				}

				if ( tempScripts.length ) {
					tempScripts.sort(function( a, b ) {
						return a.stamp - b.stamp;
					});

					basket.remove( tempScripts[ 0 ].key );

					return addLocalStorage( key, storeObj );

				} else {
					// no files to remove. Larger than available quota
					return;
				}

			} else {
				// some other error
				return;
			}
		}

	};

	const getUrl = function( url ) {
		const promise = new RSVP.Promise(function (resolve, reject) {

			const xhr = new XMLHttpRequest();
			xhr.open('GET', url);

			xhr.onreadystatechange = function () {
				if (xhr.readyState === 4) {
					if ((xhr.status === 200) ||
						((xhr.status === 0) && xhr.responseText)) {
						resolve({
							content: xhr.responseText,
							type: xhr.getResponseHeader('content-type')
						});
					} else {
						reject(new Error(xhr.statusText));
					}
				}
			};

			// By default XHRs never timeout, and even Chrome doesn't implement the
			// spec for xhr.timeout. So we do it ourselves.
			setTimeout(function () {
				if (xhr.readyState < 4) {
					xhr.abort();
				}
			}, basket.timeout);

			xhr.send();
		});

		return promise;
	};

	const wrapStoreData = function( obj, data ) {
		const now = +new Date();
		obj.data = data.content;
		obj.originalType = data.type;
		obj.type = obj.type || data.type;
		obj.skipCache = obj.skipCache || false;
		obj.stamp = now;
		obj.expire = now + ( ( obj.expire || defaultExpiration ) * 60 * 60 * 1000 );

		return obj;
	};

	const saveUrl = function( obj ) {
		return getUrl( obj.url ).then( function( result ) {
			const storeObj = wrapStoreData(obj, result);

			if (!obj.skipCache) {
				addLocalStorage( obj.key , storeObj );
			}

			return storeObj;
		});
	};

	const isCacheValid = function(source, obj) {
		return !source ||
			source.expire - +new Date() < 0  ||
			obj.unique !== source.unique ||
			(basket.isValidItem && !basket.isValidItem(source, obj));
	};

	const handleStackObject = function( obj ) {
		let source, promise, shouldFetch;

		if ( !obj.url ) {
			return;
		}

		obj.key =  ( obj.key || obj.url );
		source = basket.get( obj.key );

		obj.execute = obj.execute !== false;

		shouldFetch = isCacheValid(source, obj);

		if( obj.live || shouldFetch ) {
			if ( obj.unique ) {
				// set parameter to prevent browser cache
				obj.url += ( ( obj.url.indexOf('?') > 0 ) ? '&' : '?' ) + 'basket-unique=' + obj.unique;
			}
			promise = saveUrl( obj );

			if( obj.live && !shouldFetch ) {
				promise = promise
					.then( function( result ) {
						// If we succeed, just return the value
						// RSVP doesn't have a .fail convenience method
						return result;
					}, function() {
						return source;
					});
			}
		} else {
			source.type = obj.type || source.originalType;
			source.execute = obj.execute;
			promise = new RSVP.Promise( function( resolve ){
				resolve( source );
			});
		}

		return promise;
	};

	const injectScript = function( obj ) {
		const script = document.createElement('script');
		script.defer = true;
		// Have to use .text, since we support IE8,
		// which won't allow appending to a script
		script.text = obj.data;
		head.appendChild( script );
	};

	const handlers = {
		'default': injectScript
	};

	const execute = function( obj ) {
		if( obj.type && handlers[ obj.type ] ) {
			return handlers[ obj.type ]( obj );
		}

		return handlers['default']( obj ); // 'default' is a reserved word
	};

	const performActions = function( resources ) {
		return resources.map( function( obj ) {
			if( obj.execute ) {
				execute( obj );
			}

			return obj;
		} );
	};

	const fetch = function() {
		let i, l, promises = [];

		for ( i = 0, l = arguments.length; i < l; i++ ) {
			promises.push( handleStackObject( arguments[ i ] ) );
		}

		return RSVP.all( promises );
	};

	const thenRequire = function() {
		const resources = fetch.apply(null, arguments);
		const promise = this.then(function () {
			return resources;
		}).then(performActions);
		promise.thenRequire = thenRequire;
		return promise;
	};

	window.basket = {
		require: function() {
			for ( var a = 0, l = arguments.length; a < l; a++ ) {
				arguments[a].execute = arguments[a].execute !== false;

				if ( arguments[a].once && inBasket.indexOf(arguments[a].url) >= 0 ) {
					arguments[a].execute = false;
				} else if ( arguments[a].execute !== false && inBasket.indexOf(arguments[a].url) < 0 ) {
					inBasket.push(arguments[a].url);
				}
			}

			const promise = fetch.apply(null, arguments).then(performActions);

			promise.thenRequire = thenRequire;
			return promise;
		},

		remove: function( key ) {
			localStorage.removeItem( storagePrefix + key );
			return this;
		},

		get: function( key ) {
			const item = localStorage.getItem( storagePrefix + key );
			try	{
				return JSON.parse( item || 'false' );
			} catch( e ) {
				return false;
			}
		},

		clear: function( expired ) {
			let item, key;
			const now = +new Date();

			for ( item in localStorage ) {
				key = item.split( storagePrefix )[ 1 ];
				if ( key && ( !expired || this.get( key ).expire <= now ) ) {
					this.remove( key );
				}
			}

			return this;
		},

		isValidItem: null,

		timeout: 5000,

		addHandler: function( types, handler ) {
			if( !Array.isArray( types ) ) {
				types = [ types ];
			}
			types.forEach( function( type ) {
				handlers[ type ] = handler;
			});
		},

		removeHandler: function( types ) {
			basket.addHandler( types, undefined );
		},
		/*
		Set the default expiration for files in hours. By default it is 5000 hours. Changing this does not change currently cached files, so set it before loading files.
		 */
		setDefaultExpiration: function ( hours ) {
			const intHours = parseInt(hours);

			if (intHours >= 1) {
				defaultExpiration = intHours;
				return true;
			} else {
				console.log('Incorrect default expiration hours set.');
				return false;
			}
		},

		getDefaultExpiration: function () {
			return defaultExpiration;
		}
	};

	// delete expired keys
	basket.clear( true );

})( this, document );
