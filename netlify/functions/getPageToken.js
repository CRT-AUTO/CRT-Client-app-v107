// This function exchanges a user access token for a page access token
const axios = require('axios');

exports.handler = async (event, context) => {
  // Set CORS headers for all responses
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
  
  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers
    };
  }
  
  // Extract parameters from the request
  let userToken, pageId;
  
  if (event.httpMethod === 'GET') {
    userToken = event.queryStringParameters?.token;
    pageId = event.queryStringParameters?.pageId;
  } else if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);
      userToken = body.token;
      pageId = body.pageId;
    } catch (e) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid request body' })
      };
    }
  }
  
  if (!userToken || !pageId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing required parameters (token and pageId)' })
    };
  }
  
  try {
    // Get page access token
    console.log(`Getting page token for page ID: ${pageId}`);
    
    const response = await axios.get(`https://graph.facebook.com/v18.0/${pageId}`, {
      params: {
        fields: 'access_token,name,category',
        access_token: userToken
      }
    });
    
    if (!response.data.access_token) {
      console.error('No page token returned from Facebook:', response.data);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Failed to retrieve page token' })
      };
    }
    
    // Now exchange for a long-lived page token
    const longLivedResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.VITE_META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: response.data.access_token
      }
    });
    
    // Default expiry is 60 days for page tokens if not specified
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 60);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        pageId: pageId,
        pageName: response.data.name,
        pageCategory: response.data.category,
        accessToken: longLivedResponse.data.access_token || response.data.access_token,
        // Facebook doesn't always return expires_in for page tokens as they're typically long-lived
        expiresIn: longLivedResponse.data.expires_in || 5184000, // 60 days in seconds
        expiryDate: expiryDate.toISOString()
      })
    };
    
  } catch (error) {
    console.error('Error getting page token:', error.response?.data || error.message);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: error.response?.data?.error?.message || error.message || 'Error retrieving page token'
      })
    };
  }
};
