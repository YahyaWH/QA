// Simple script to check what dotenv is reading
require('dotenv').config();

console.log('=== CHECKING .env FILE ===\n');

const email = process.env.TEST_ADMIN_EMAIL;
const password = process.env.TEST_ADMIN_PASSWORD;

console.log('Email:', email);
console.log('Email length:', email?.length);
console.log('Email first char:', email?.charAt(0));
console.log('Email last char:', email?.charAt(email?.length - 1));

console.log('\n=== PASSWORD ANALYSIS ===');
console.log('Password:', password);
console.log('Password length:', password?.length);
console.log('Password first char:', password?.charAt(0));
console.log('Password last char:', password?.charAt(password?.length - 1));

console.log('\n=== CHECKING FOR QUOTE CHARACTERS ===');
console.log('Starts with double quote?', password?.startsWith('"'));
console.log('Ends with double quote?', password?.endsWith('"'));

console.log('\n=== CHARACTER BREAKDOWN ===');
if (password) {
  console.log('Each character:');
  for (let i = 0; i < password.length; i++) {
    const char = password.charAt(i);
    const code = password.charCodeAt(i);
    console.log(`  [${i}]: '${char}' (ASCII: ${code})`);
  }
}

console.log('\n=== EXPECTED PASSWORD ===');
console.log('Should be: yP@9!2#8MQR (11 characters)');
console.log('Actual length:', password?.length);
console.log('Match?', password === 'yP@9!2#8MQR');
