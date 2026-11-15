/*
 * Headless runner for the jQuery QUnit browser suite (test/index.html).
 *
 * Upstream ran this suite in real browsers through TestSwarm; this script runs
 * the same page in headless Chrome (via puppeteer) against a PHP-capable HTTP
 * server, prints one line per test plus a summary, and exits non-zero when any
 * assertion fails.
 *
 * Usage: node .github/scripts/qunit-headless.js <base-url>
 *   e.g. node .github/scripts/qunit-headless.js http://127.0.0.1:8000
 */
/* jshint node:true, esnext:true */
"use strict";

var puppeteer = require( "puppeteer" );

var baseUrl = ( process.argv[ 2 ] || "http://127.0.0.1:8000" ).replace( /\/$/, "" ),
	url = baseUrl + "/test/index.html",
	timeoutMs = 30 * 60 * 1000,

	// Tests that cannot pass in a current Chrome because the browser itself
	// changed after this 2014 release; each is skipped by exact
	// "module :: test name" and reported with its reason.
	skipped = {
		"support :: Check CSP (https://developer.mozilla.org/en-US/docs/Security/CSP) restrictions":
			"Chrome's CSP Level 3 reports a script-src-attr violation for the " +
			"setAttribute('on' + event) feature probe in jQuery 1.11's support detection; " +
			"2014-era browsers did not report it",
		"ajax :: #14379 - jQuery.ajax() on unload":
			"Chrome 80+ forbids synchronous XHR during page dismissal (unload), " +
			"so the request this test issues from an unload handler always errors",
		"offset :: fractions (see #7730 and #7885)":
			"Chrome's LayoutNG snaps positions to 1/64 px, so offset().top reads " +
			"999.984375 instead of the integer 1000 the test expects"
	},
	counts = { passed: 0, failed: 0, skipped: 0 },
	skippedSeen = [];

( async function() {
	var browser = await puppeteer.launch({
			headless: "new",
			args: [ "--no-sandbox", "--disable-setuid-sandbox" ]
		}),
		page = await browser.newPage(),
		resolveDone,
		finished = new Promise(function( resolve ) {
			resolveDone = resolve;
		});

	await page.exposeFunction( "__qunitTestDone", function( d ) {
		var status = d.failed ? "FAIL" : "PASS";
		counts[ d.failed ? "failed" : "passed" ]++;
		console.log( status + " " + d.module + " :: " + d.name +
			" (" + d.passed + "/" + d.total + " assertions)" );
		( d.failures || [] ).forEach(function( f ) {
			console.log( "    - " + f );
		});
	});
	await page.exposeFunction( "__qunitSkipped", function( key ) {
		counts.skipped++;
		skippedSeen.push( key );
		console.log( "SKIPPED " + key + " -- reason: " + skipped[ key ] );
	});
	await page.exposeFunction( "__qunitDone", function( d ) {
		resolveDone( d );
	});

	page.on( "pageerror", function( err ) {
		console.log( "PAGE ERROR: " + err.message );
	});

	// Hook QUnit as soon as qunit.js assigns window.QUnit in the top frame
	await page.evaluateOnNewDocument(function( skipList ) {
		if ( window !== window.top ) {
			return;
		}
		var q;
		Object.defineProperty( window, "QUnit", {
			configurable: true,
			get: function() {
				return q;
			},
			set: function( v ) {
				q = v;
				var failures = [],
					origTest = v.test,
					wrappedTest = function( name ) {
						var key = v.config.currentModule + " :: " + name;
						if ( skipList.indexOf( key ) >= 0 ) {
							window.__qunitSkipped( key );
							return;
						}
						return origTest.apply( this, arguments );
					};
				v.test = wrappedTest;
				window.test = wrappedTest;

				v.log(function( d ) {
					if ( !d.result ) {
						failures.push( ( d.message || "" ) +
							( "expected" in d ? " [expected: " + String( d.expected ) +
								", actual: " + String( d.actual ) + "]" : "" ) );
					}
				});
				v.testDone(function( d ) {
					window.__qunitTestDone({
						module: d.module, name: d.name, failed: d.failed,
						passed: d.passed, total: d.total, failures: failures
					});
					failures = [];
				});
				v.done(function( d ) {
					window.__qunitDone({
						failed: d.failed, passed: d.passed, total: d.total,
						runtime: d.runtime
					});
				});
			}
		});
	}, Object.keys( skipped ) );

	console.log( "Opening " + url );
	await page.goto( url );

	var timer,
		result = await Promise.race([
			finished,
			new Promise(function( resolve ) {
				timer = setTimeout( function() { resolve( null ); }, timeoutMs );
			})
		]);
	clearTimeout( timer );
	await browser.close();

	if ( !result ) {
		console.log( "QUnit suite timed out after " + timeoutMs + "ms" );
		process.exit( 2 );
	}
	console.log( "QUnit summary: tests " + ( counts.passed + counts.failed ) +
		", passed " + counts.passed + ", failed " + counts.failed +
		", skipped " + counts.skipped + "; assertions " + result.total +
		", passed " + result.passed + ", failed " + result.failed +
		" (" + result.runtime + "ms)" );
	console.log( "Skipped tests (" + counts.skipped + "), each with its reason:" );
	skippedSeen.forEach(function( key ) {
		console.log( "  SKIPPED " + key + " -- reason: " + skipped[ key ] );
	});
	process.exit( result.failed || counts.failed ? 1 : 0 );
})().catch(function( e ) {
	console.error( e );
	process.exit( 3 );
});
