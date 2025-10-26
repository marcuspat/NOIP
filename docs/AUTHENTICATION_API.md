# NOIP Platform Authentication API Documentation

## Overview

The NOIP Platform provides a comprehensive enterprise-grade authentication system with the following features:

- **JWT-based Authentication** with secure token management
- **Role-Based Access Control (RBAC)** for granular permissions
- **Multi-Factor Authentication (MFA)** support (TOTP, SMS, Email)
- **Advanced Security** with rate limiting, audit logging, and session management
- **Password Management** with secure policies and reset functionality
- **Email Verification** for user registration
- **Enterprise Security** with device fingerprinting and security event tracking

## Base URL

```
http://localhost:3000/auth
```

## Authentication

All protected endpoints require authentication via JWT tokens. Include the token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

## API Endpoints

### Authentication Endpoints

#### User Registration

```http
POST /auth/register
```

Registers a new user account.

**Request Body:**
```json
{
  "username": "string (3-50 chars)",
  "email": "string (valid email)",
  "password": "string (min 8 chars)",
  "firstName": "string (max 50 chars)",
  "lastName": "string (max 50 chars)",
  "agreeToTerms": "boolean"
}
```

**Response:**
```json
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "user": {
      "id": "string",
      "username": "string",
      "email": "string",
      "firstName": "string",
      "lastName": "string",
      "roles": ["string"],
      "permissions": ["string"],
      "status": "pending_verification|active|inactive|suspended|locked",
      "mfaEnabled": "boolean",
      "emailVerified": "boolean",
      "createdAt": "datetime"
    },
    "requiresVerification": "boolean"
  }
}
```

#### User Login

```http
POST /auth/login
```

Authenticates a user and returns access tokens.

**Request Body:**
```json
{
  "username": "string",
  "password": "string",
  "mfaCode": "string (optional, 6 digits)",
  "rememberMe": "boolean (optional)",
  "deviceFingerprint": "string (optional)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { /* User profile */ },
    "tokens": {
      "accessToken": "string",
      "refreshToken": "string",
      "expiresIn": "number",
      "tokenType": "Bearer"
    },
    "requiresMFA": "boolean",
    "mfaMethods": ["string"] // Only if requiresMFA is true
  }
}
```

#### Refresh Token

```http
POST /auth/refresh
```

Refreshes an access token using a refresh token.

**Request Body:**
```json
{
  "refreshToken": "string" // Optional, can also use cookie
}
```

**Response:**
```json
{
  "success": true,
  "message": "Token refreshed successfully",
  "data": {
    "tokens": {
      "accessToken": "string",
      "refreshToken": "string",
      "expiresIn": "number",
      "tokenType": "Bearer"
    }
  }
}
```

#### User Logout

```http
POST /auth/logout
```

Logs out the current user and invalidates their session.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "success": true,
  "message": "Logout successful"
}
```

### Profile Management

#### Get User Profile

```http
GET /auth/profile
```

Retrieves the current user's profile information.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "string",
      "username": "string",
      "email": "string",
      "firstName": "string",
      "lastName": "string",
      "roles": ["string"],
      "permissions": ["string"],
      "status": "string",
      "mfaEnabled": "boolean",
      "lastLogin": "datetime",
      "emailVerified": "boolean",
      "createdAt": "datetime"
    }
  }
}
```

### Password Management

#### Change Password

```http
POST /auth/change-password
```

Changes the current user's password.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "currentPassword": "string",
  "newPassword": "string",
  "confirmPassword": "string"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

#### Request Password Reset

```http
POST /auth/password-reset
```

Requests a password reset email for a user.

**Request Body:**
```json
{
  "email": "string"
}
```

**Response:**
```json
{
  "success": true,
  "message": "If an account with that email exists, a password reset link has been sent"
}
```

#### Confirm Password Reset

```http
POST /auth/password-reset/confirm
```

Confirms a password reset using a token.

**Request Body:**
```json
{
  "token": "string",
  "newPassword": "string",
  "confirmPassword": "string"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Password reset successfully"
}
```

### Email Verification

#### Verify Email

```http
GET /auth/verify-email?token=<token>
```

Verifies a user's email address using a verification token.

**Query Parameters:**
- `token` (string, required): Email verification token

**Response:**
```json
{
  "success": true,
  "message": "Email verified successfully"
}
```

### Multi-Factor Authentication

#### Setup MFA

```http
POST /auth/mfa/setup
```

Initiates MFA setup for the current user.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "method": "totp|sms|email",
  "phoneNumber": "string (required for SMS)",
  "emailAddress": "string (required for email)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "MFA setup initiated",
  "data": {
    "secret": "string (for TOTP)",
    "qrCode": "string (for TOTP)",
    "backupCodes": ["string"],
    "verificationRequired": "boolean"
  }
}
```

#### Verify MFA

```http
POST /auth/mfa/verify
```

Verifies an MFA code during login or setup.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "code": "string (6 digits)",
  "method": "totp|sms|email|backup",
  "backupCode": "string (if using backup code)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "MFA verification successful"
}
```

### Admin Endpoints

#### Get Authentication Metrics

```http
GET /auth/metrics
```

Retrieves authentication system metrics (admin only).

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "metrics": {
      "totalUsers": "number",
      "activeUsers": "number",
      "activeSessions": "number",
      "loginAttempts24h": "number",
      "successfulLogins24h": "number",
      "failedLogins24h": "number",
      "mfaAdoptionRate": "number",
      "securityEvents24h": "number",
      "accountsLocked": "number",
      "passwordResets24h": "number"
    }
  }
}
```

#### Get Rate Limit Status

```http
GET /auth/rate-limit
```

Gets current rate limiting status (admin only).

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "rateLimit": {
      "remaining": "number",
      "resetTime": "number",
      "total": "number"
    }
  }
}
```

### Health Check

#### Health Check

```http
GET /auth/health
```

Checks the health status of the authentication service.

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "healthy|unhealthy",
    "details": {
      "activeUsers": "number",
      "activeSessions": "number",
      "uptime": "number"
    }
  }
}
```

## Security Features

### Rate Limiting

The API implements comprehensive rate limiting:

- **Authentication endpoints**: 5 requests per 15 minutes per IP/user
- **Password reset**: 3 requests per hour per email
- **MFA verification**: 10 requests per 5 minutes per user
- **General API**: 100 requests per 15 minutes per IP

Rate limit headers are included in responses:
- `X-RateLimit-Limit`: Maximum requests allowed
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Time when limit resets (Unix timestamp)
- `Retry-After`: Seconds until next request is allowed

### Security Headers

All responses include security headers:
- `Strict-Transport-Security`: Enforces HTTPS
- `X-Frame-Options`: Prevents clickjacking
- `X-Content-Type-Options`: Prevents MIME sniffing
- `Content-Security-Policy`: Prevents XSS attacks

### Session Management

- Sessions are tracked with device fingerprinting
- Automatic session expiration after inactivity
- Concurrent session limits (configurable)
- Session invalidation on password change
- Secure session storage with Redis

### Audit Logging

All authentication events are logged with:
- User ID and session ID
- IP address and user agent
- Event type and severity
- Timestamp and detailed context

## Error Responses

### Standard Error Format

```json
{
  "success": false,
  "error": "Error message",
  "details": "Additional error details (optional)"
}
```

### Common HTTP Status Codes

- `200 OK`: Request successful
- `201 Created`: Resource created successfully
- `400 Bad Request`: Invalid request data
- `401 Unauthorized`: Authentication required or invalid
- `403 Forbidden`: Insufficient permissions
- `404 Not Found`: Resource not found
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

### Authentication Errors

| Error | Description | HTTP Status |
|-------|-------------|-------------|
| `Authentication required` | No token provided | 401 |
| `Invalid or expired token` | JWT token is invalid or expired | 401 |
| `Session expired or invalid` | User session is not valid | 401 |
| `MFA verification required` | MFA code needed to continue | 403 |
| `Insufficient permissions` | User lacks required role/permission | 403 |
| `Email verification required` | User email not verified | 403 |
| `Account is locked` | User account is temporarily locked | 401 |

## Configuration

### Environment Variables

```bash
# Authentication Service
AUTH_SERVICE_ENABLED=true
TOKEN_ROTATION_INTERVAL=3600000
SESSION_TIMEOUT=86400000
MAX_CONCURRENT_SESSIONS=5
PASSWORD_EXPIRY_DAYS=90
ACCOUNT_LOCKOUT_ATTEMPTS=5
ACCOUNT_LOCKOUT_DURATION=7200000
MFA_GRACE_PERIOD=604800000

# JWT Configuration
JWT_SECRET=your-secret-key
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
JWT_ISSUER=NOIP Platform
JWT_AUDIENCE=noip-client

# Password Policy
PASSWORD_MIN_LENGTH=8
PASSWORD_REQUIRE_UPPERCASE=true
PASSWORD_REQUIRE_LOWERCASE=true
PASSWORD_REQUIRE_NUMBERS=true
PASSWORD_REQUIRE_SPECIAL=true
PASSWORD_PREVENT_REUSE=5
PASSWORD_MAX_AGE=7776000000

# MFA Configuration
MFA_TOTP_WINDOW=2
MFA_SMS_CODE_LENGTH=6
MFA_EMAIL_CODE_LENGTH=6
MFA_BACKUP_CODE_COUNT=10
MFA_CODE_EXPIRY=300000

# Rate Limiting
RATE_LIMIT_WINDOW=900000
RATE_LIMIT_MAX=100
RATE_LIMIT_AUTH_WINDOW=900000
RATE_LIMIT_AUTH_MAX=5
RATE_LIMIT_PASSWORD_RESET_WINDOW=3600000
RATE_LIMIT_PASSWORD_RESET_MAX=3
RATE_LIMIT_MFA_WINDOW=300000
RATE_LIMIT_MFA_MAX=10

# Audit Configuration
AUDIT_LOG_LEVEL=detailed
AUDIT_MAX_BODY_SIZE=10240
AUDIT_RETENTION_DAYS=365

# Email Configuration
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=your-password
EMAIL_FROM=noreply@noip.platform
```

## Integration Examples

### JavaScript/Node.js

```javascript
// User Registration
const registerUser = async (userData) => {
  const response = await fetch('/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(userData)
  });

  return await response.json();
};

// User Login
const loginUser = async (credentials) => {
  const response = await fetch('/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(credentials)
  });

  const result = await response.json();

  if (result.success) {
    // Store tokens securely
    localStorage.setItem('accessToken', result.data.tokens.accessToken);
    localStorage.setItem('refreshToken', result.data.tokens.refreshToken);
  }

  return result;
};

// Authenticated API Request
const getProfile = async () => {
  const token = localStorage.getItem('accessToken');

  const response = await fetch('/auth/profile', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    }
  });

  return await response.json();
};

// Token Refresh
const refreshToken = async () => {
  const refreshToken = localStorage.getItem('refreshToken');

  const response = await fetch('/auth/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refreshToken })
  });

  const result = await response.json();

  if (result.success) {
    localStorage.setItem('accessToken', result.data.tokens.accessToken);
    localStorage.setItem('refreshToken', result.data.tokens.refreshToken);
  }

  return result;
};
```

### Python

```python
import requests

# User Registration
def register_user(username, email, password, first_name, last_name):
    response = requests.post('/auth/register', json={
        'username': username,
        'email': email,
        'password': password,
        'firstName': first_name,
        'lastName': last_name,
        'agreeToTerms': True
    })
    return response.json()

# User Login
def login_user(username, password):
    response = requests.post('/auth/login', json={
        'username': username,
        'password': password
    })

    result = response.json()
    if result.get('success'):
        # Store tokens for subsequent requests
        access_token = result['data']['tokens']['accessToken']
        refresh_token = result['data']['tokens']['refreshToken']

        return result, access_token, refresh_token

    return result, None, None

# Authenticated Request
def get_profile(access_token):
    headers = {'Authorization': f'Bearer {access_token}'}
    response = requests.get('/auth/profile', headers=headers)
    return response.json()

# Token Refresh
def refresh_token(refresh_token):
    response = requests.post('/auth/refresh', json={
        'refreshToken': refresh_token
    })

    result = response.json()
    if result.get('success'):
        new_access_token = result['data']['tokens']['accessToken']
        new_refresh_token = result['data']['tokens']['refreshToken']
        return result, new_access_token, new_refresh_token

    return result, None, None
```

## Security Best Practices

### For Client Applications

1. **Token Storage**: Store tokens securely (httpOnly cookies recommended)
2. **HTTPS**: Always use HTTPS in production
3. **Token Validation**: Validate tokens before using them
4. **Error Handling**: Handle authentication errors gracefully
5. **Logout**: Implement proper logout functionality
6. **Token Refresh**: Refresh tokens before they expire
7. **MFA**: Implement MFA verification when required

### For Server Applications

1. **Secret Management**: Keep JWT secrets secure and rotate them regularly
2. **Rate Limiting**: Implement appropriate rate limits
3. **Audit Logging**: Log all authentication events
4. **Session Management**: Implement proper session timeout and cleanup
5. **Password Policies**: Enforce strong password requirements
6. **Security Headers**: Include all necessary security headers
7. **Input Validation**: Validate all input data
8. **Error Messages**: Use generic error messages to prevent information leakage

## Support

For authentication-related issues or questions:

1. Check the application logs for detailed error information
2. Verify environment configuration
3. Test with the provided examples
4. Review the audit logs for security events
5. Contact the development team for complex issues

## Changelog

### Version 1.0.0
- Initial release with core authentication features
- JWT-based authentication
- Role-based access control
- Multi-factor authentication support
- Password management
- Email verification
- Comprehensive security features
- Rate limiting and audit logging