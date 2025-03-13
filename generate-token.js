const admin = require('firebase-admin');

const serviceAccount = require('./firebase-service-account.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

admin.auth().createCustomToken("6Pf9QSsVnfMPVzszVlpqWdjyqej1")
    .then(token => console.log("New Firebase Token:", token))
    .catch(err => console.error(err));
