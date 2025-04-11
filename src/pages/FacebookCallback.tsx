import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { MessageSquare, AlertCircle, Facebook } from 'lucide-react';
import { restoreFacebookAuthState } from '../lib/facebookAuth';

// Type definition for Facebook Page
interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
  category: string;
}

export default function FacebookCallback() {
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(true);
  const [status, setStatus] = useState<'processing' | 'auth_restore' | 'exchanging_code' | 'getting_pages' | 'saving' | 'success' | 'error'>('processing');
  const [debugInfo, setDebugInfo] = useState<string[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [availablePages, setAvailablePages] = useState<FacebookPage[]>([]);
  const [authRestoreAttempted, setAuthRestoreAttempted] = useState(false);
  const [maxAttempts] = useState(3); // Maximum number of auth restore attempts
  const [restoreAttemptCount, setRestoreAttemptCount] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();

  const addDebugInfo = (message: string) => {
    console.log(message);
    setDebugInfo(prev => [...prev, `${new Date().toISOString().slice(11, 19)}: ${message}`]);
  };

  // First, attempt to restore authentication state
  useEffect(() => {
    const restoreAuth = async () => {
      // Only attempt restore a limited number of times
      if (authRestoreAttempted || restoreAttemptCount >= maxAttempts) return;
      
      addDebugInfo('Attempting to restore authentication state');
      setStatus('auth_restore');
      setRestoreAttemptCount(prev => prev + 1);
      
      // Check if we have saved auth state
      const savedState = localStorage.getItem('fb_auth_state');
      if (savedState) {
        try {
          const parsedState = JSON.parse(savedState);
          addDebugInfo(`Found saved auth state for user ${parsedState.userId?.slice(0, 8) || 'unknown'}...`);
          
          // Check if the state is recent enough (less than 15 minutes old)
          const stateAgeMinutes = (Date.now() - parsedState.timestamp) / (60 * 1000);
          addDebugInfo(`Auth state is ${stateAgeMinutes.toFixed(1)} minutes old`);
          
          if (stateAgeMinutes > 15) {
            addDebugInfo('Auth state is too old, removing it');
            localStorage.removeItem('fb_auth_state');
          }
        } catch (e) {
          addDebugInfo(`Error parsing saved auth state: ${e instanceof Error ? e.message : 'Unknown error'}`);
          // Remove invalid state
          localStorage.removeItem('fb_auth_state');
        }
      } else {
        addDebugInfo('No saved auth state found');
      }
      
      // First check if we're already authenticated
      const { data: { session } } = await supabase.auth.getSession();
      
      if (session) {
        addDebugInfo(`Already authenticated as ${session.user.email || session.user.id}`);
        setAuthRestoreAttempted(true);
        return;
      }

      try {
        const restored = await restoreFacebookAuthState();
        
        if (restored) {
          addDebugInfo('Authentication state restored successfully');
          setAuthRestoreAttempted(true);
        } else {
          addDebugInfo('Could not restore authentication state, will attempt to continue anyway');
          
          // We might need to redirect back to auth
          if (!session) {
            addDebugInfo('No active session, redirecting to auth page in 5 seconds...');
            setTimeout(() => {
              navigate('/auth', { 
                state: { 
                  message: 'Session expired. Please log in again to complete Facebook connection.',
                  fromOAuth: true 
                } 
              });
            }, 5000);
          }
        }
      } catch (restoreError) {
        addDebugInfo(`Error restoring auth state: ${restoreError instanceof Error ? restoreError.message : 'Unknown error'}`);
        
        // If we've reached max attempts, redirect to auth
        if (restoreAttemptCount >= maxAttempts) {
          addDebugInfo(`Max restore attempts (${maxAttempts}) reached, redirecting to auth`);
          setTimeout(() => {
            navigate('/auth', { 
              state: { 
                message: 'Failed to restore session. Please log in again to complete Facebook connection.',
                fromOAuth: true 
              } 
            });
          }, 3000);
        } else {
          // Try again after a delay
          setTimeout(() => {
            setAuthRestoreAttempted(false);  // Reset flag to retry
          }, 1500);
        }
      }
    };
    
    restoreAuth();
  }, [navigate, authRestoreAttempted, restoreAttemptCount, maxAttempts]);

  // Then process the Facebook callback once auth restore is attempted
  useEffect(() => {
    // If we're still trying to restore auth, skip processing the callback
    if (!authRestoreAttempted) return;
    
    async function handleFacebookCallback() {
      try {
        // Extract code from URL
        const params = new URLSearchParams(location.search);
        const code = params.get('code');
        
        if (!code) {
          throw new Error('Authorization code not found');
        }

        addDebugInfo(`Processing Facebook callback with code: ${code.substring(0, 10)}...`);
        setStatus('processing');

        // Get the current user
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (userError) {
          addDebugInfo(`Error getting user: ${userError.message}`);
          throw userError;
        }
        
        if (!userData.user) {
          addDebugInfo('User not authenticated');
          throw new Error('User not authenticated');
        }

        addDebugInfo(`Authenticated as user ID: ${userData.user.id}`);

        // Check for pre-stored pages from Facebook login
        let pages: FacebookPage[] = [];
        const storedPagesStr = localStorage.getItem('fb_pages');
        
        if (storedPagesStr) {
          try {
            const storedPages = JSON.parse(storedPagesStr);
            if (Array.isArray(storedPages) && storedPages.length > 0) {
              pages = storedPages;
              addDebugInfo(`Found ${pages.length} pages in local storage`);
            }
          } catch (e) {
            addDebugInfo('Error parsing stored pages: ' + String(e));
          }
        }
        
        // For demonstration, if no pages were found in storage,
        // we'll simulate the FB Graph API call to exchange code for token
        if (pages.length === 0) {
          addDebugInfo('No stored pages found, simulating token exchange...');
          setStatus('exchanging_code');
          
          // Simulate API delay
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Simulating getting a list of pages (in production this would come from the API)
          pages = [
            {
              id: '101234567890123',
              name: 'Test Business Page',
              access_token: `EAA${Math.random().toString(36).substring(2, 15)}`,
              category: 'Business'
            }
          ];
        }
        
        if (pages.length === 0) {
          throw new Error('No Facebook pages available for this account');
        }
        
        // If we have exactly one page, use it directly
        let selectedPageId: string;
        let selectedPage: FacebookPage;
        
        if (pages.length === 1) {
          selectedPageId = pages[0].id;
          selectedPage = pages[0];
          addDebugInfo(`Auto-selected the only available page: ${selectedPage.name}`);
        } else if (pages.length > 1) {
          // In a real app, you would show UI for page selection
          selectedPageId = pages[0].id;
          selectedPage = pages[0];
          addDebugInfo(`Multiple pages available, selecting first one: ${selectedPage.name}`);
        } else {
          throw new Error('No Facebook pages available');
        }
        
        // Calculate token expiry - 60 days from now for long-lived tokens
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 60);
        
        // Save to database
        setStatus('saving');
        addDebugInfo('Saving Facebook connection to database...');
        
        // Check for existing connection
        const { data: existingConnections, error: connectionError } = await supabase
          .from('social_connections')
          .select('*')
          .eq('user_id', userData.user.id)
          .eq('fb_page_id', selectedPageId);
          
        if (connectionError) {
          addDebugInfo(`Error checking existing connections: ${connectionError.message}`);
          throw connectionError;
        }
        
        if (existingConnections && existingConnections.length > 0) {
          // Update existing connection
          addDebugInfo('Updating existing Facebook connection');
          const { error: updateError } = await supabase
            .from('social_connections')
            .update({
              access_token: selectedPage.access_token,
              token_expiry: expiryDate.toISOString(),
              refreshed_at: new Date().toISOString()
            })
            .eq('id', existingConnections[0].id);
            
          if (updateError) {
            addDebugInfo(`Error updating connection: ${updateError.message}`);
            throw updateError;
          }
        } else {
          // Create new connection
          addDebugInfo('Creating new Facebook connection');
          const { error: insertError } = await supabase
            .from('social_connections')
            .insert({
              user_id: userData.user.id,
              fb_page_id: selectedPageId,
              access_token: selectedPage.access_token,
              token_expiry: expiryDate.toISOString()
            });
            
          if (insertError) {
            addDebugInfo(`Error creating connection: ${insertError.message}`);
            throw insertError;
          }
        }
        
        // Clean up storage
        localStorage.removeItem('fb_pages');
        localStorage.removeItem('fb_auth_state');
        
        addDebugInfo('Facebook connection saved successfully');
        setStatus('success');
        
        // Success! Wait a moment then redirect
        setTimeout(() => {
          navigate('/settings', { replace: true });
        }, 2000);
        
      } catch (err) {
        console.error('Facebook OAuth Error:', err);
        addDebugInfo(`Facebook OAuth Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
        setError('Failed to connect your Facebook account. Please try again.');
        setStatus('error');
        setProcessing(false);
      }
    }

    handleFacebookCallback();
  }, [location, navigate, authRestoreAttempted]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <MessageSquare className="h-12 w-12 text-indigo-600" />
        </div>
        <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
          Connecting Facebook
        </h2>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10 text-center">
          {status === 'processing' || status === 'auth_restore' || status === 'exchanging_code' || status === 'getting_pages' || status === 'saving' ? (
            <>
              <div className="flex justify-center mb-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
              </div>
              <p className="text-gray-700">
                {status === 'processing' && 'Processing your Facebook connection...'}
                {status === 'auth_restore' && 'Restoring your authentication session...'}
                {status === 'exchanging_code' && 'Exchanging authorization code for access token...'}
                {status === 'getting_pages' && 'Retrieving your Facebook pages...'}
                {status === 'saving' && 'Saving your Facebook page connection...'}
              </p>
              <p className="text-sm text-gray-500 mt-2">
                This might take a moment.
              </p>
            </>
          ) : status === 'error' ? (
            <>
              <div className="flex justify-center mb-4">
                <AlertCircle className="h-12 w-12 text-red-500" />
              </div>
              <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 mb-4 rounded-md text-sm">
                {error}
              </div>
              <button
                onClick={() => navigate('/settings')}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Go Back to Settings
              </button>
            </>
          ) : (
            <>
              <div className="flex justify-center mb-4">
                <Facebook className="h-12 w-12 text-blue-600" />
              </div>
              <div className="bg-green-50 border border-green-200 text-green-600 px-4 py-3 mb-4 rounded-md text-sm">
                Successfully connected to Facebook!
              </div>
              <p className="text-gray-700 mb-4">Redirecting you back to settings...</p>
            </>
          )}
          
          {/* Debug info section */}
          {debugInfo.length > 0 && (
            <div className="mt-6 p-3 bg-gray-50 rounded-md text-left">
              <p className="text-xs text-gray-500 font-semibold mb-1">Debug Information:</p>
              <div className="text-xs text-gray-500 max-h-40 overflow-y-auto">
                {debugInfo.map((info, idx) => (
                  <div key={idx}>{info}</div>
                ))}
              </div>
            </div>
          )}
          
          {/* Manual navigation option if stuck */}
          {(status === 'auth_restore' || status === 'processing') && debugInfo.length > 5 && (
            <div className="mt-4">
              <button
                onClick={() => navigate('/auth')}
                className="px-3 py-1 text-sm text-indigo-600 hover:text-indigo-500 border border-indigo-200 rounded"
              >
                Taking too long? Go to login page
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}