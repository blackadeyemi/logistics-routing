// "+2348031234567" to "0803 123 4567", as dispatchers write numbers.
function fmtPhoneLocal(e164) {
  const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : e164;
}

module.exports = { fmtPhoneLocal };
