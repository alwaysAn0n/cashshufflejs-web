const fs = require('fs');
const browserify = require('browserify');
const b = browserify('lib/exports.js', {
  debug: true
  // standalone: 'ShuffleClient'
});

b.bundle(function(err, someBuffer) {
  if (err) {
    console.log('There was an error:', err);
    return;
  }

  // Bypass the version check which causes https://github.com/bitpay/bitcore/issues/1454
  const contents = someBuffer
    .toString()
    .replace(/(bch.versionGuard =[^\n]+)(\n)/ig, '$1 return;$2')
    // Remove the pathname of the builder which may include personally
    // identifiable information like hostname and directory structure.
    .replace(new RegExp(process.env.PWD,'g'), '/ur/mum/m8/')
    // Show all debug messages as console.logs when running in a browser.
    .replace(/require\('debug'\)\('cashshufflejs-web'\)/ig, 'console.log');

  fs.writeFile('dist/ShuffleClient.js', contents, function(err) {
    if (err) {
      console.log('There was an error:', err);
    }
  });

});
