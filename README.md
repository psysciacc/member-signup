## PSA and ManyLanguages Sign Up Form

- Welcome to the registration website for the Psychological Science Accelerator and ManyLanguages.
- The membership website is located at: https://canvas.psysciacc.org/
- If you know you have an account but don't know the password, you can go to the member login page, and use "Forgot Password" to reset password.
- If you aren't sure you have an account, you can email the [web admin](psa.membersite@gmail.com) to ask if you have an account. 

## How signups work

This page (`index.html`) is a static form hosted on GitHub Pages. It posts to a
Cloudflare Worker that stores signups privately, emails the admin an approve/deny
link, and creates approved people as Canvas users. See [worker/README.md](worker/README.md)
for setup and deployment.
